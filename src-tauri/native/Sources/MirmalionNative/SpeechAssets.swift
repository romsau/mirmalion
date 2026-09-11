import Foundation
import Speech

// L'installation des ressources de transcription d'une langue.
//
// « 0 téléchargement » vaut pour le LLM et la traduction, pas pour le STT : sur un Mac
// ordinaire, 2 des 6 langues seulement ont leurs ressources (`fr`, `en`). Une langue absente
// ne transcrit rien — le moteur démarre et reste muet, sans rien signaler.
//
// ⚠️ Rien ne part sans un clic : c'est une opération réseau, proposée et jamais déclenchée.
// Aucun appel de ce fichier n'est fait au chargement d'un écran.
//
// ⚠️ `AssetInventory.status(forModules:)` ne dit pas si une langue est installée : elle rend
// `.supported` pour toutes celles du périmètre, y compris celles qui transcrivent vraiment.
// La seule source de vérité est `SpeechTranscriber.installedLocales`.

/// Ce qu'une installation émet, au fil de l'eau. Traverse le pont en JSON.
///
/// - Warning: ⚠️ un seul canal pour les cinq natures, comme pour la transcription : elles sont
///   ordonnées, et un abonné à plusieurs canaux pourrait recevoir la fin avant le dernier
///   pourcentage.
enum AssetInstallEvent {
  /// Avancement, entre 0 et 1.
  case progress(language: String, fraction: Double)
  /// Les ressources sont en place. La langue devient transcriptible.
  case installed(language: String)
  /// Le quota de réservations est plein.
  ///
  /// - Warning: ⚠️ un cas à part, pas un échec parmi d'autres : il ne se répare pas en
  ///   réessayant, il faut retirer une langue. Le distinguer par un `kind` permet à
  ///   l'interface de le dire dans la langue de l'utilisateur — le message d'Apple, lui, est
  ///   en anglais (« Too many allocated locales, 5 maximum »).
  case full(language: String)
  /// L'utilisateur a renoncé : rien n'est installé, et ce n'est pas une erreur.
  case cancelled(language: String)
  /// L'installation a échoué. Le message est destiné à l'utilisateur.
  case failed(language: String, message: String)

  /// L'évènement encodé en JSON, tel qu'il traverse le pont.
  var json: String {
    func quoted(_ value: String) -> String {
      String(data: (try? JSONEncoder().encode(value)) ?? Data("\"\"".utf8), encoding: .utf8)
        ?? "\"\""
    }
    switch self {
    case .progress(let language, let fraction):
      return "{\"kind\":\"progress\",\"language\":\(quoted(language)),\"progress\":\(fraction)}"
    case .installed(let language):
      return "{\"kind\":\"installed\",\"language\":\(quoted(language))}"
    case .full(let language):
      return "{\"kind\":\"full\",\"language\":\(quoted(language))}"
    case .cancelled(let language):
      return "{\"kind\":\"cancelled\",\"language\":\(quoted(language))}"
    case .failed(let language, let message):
      return
        "{\"kind\":\"failed\",\"language\":\(quoted(language)),\"message\":\(quoted(message))}"
    }
  }
}

/// L'observateur côté Rust. Même contrat que `TranscriptionObserver`.
public typealias AssetInstallObserver = @convention(c) (UnsafePointer<CChar>?) -> Void

/// Installe les ressources d'une langue, une à la fois.
///
/// Une seule installation en vol : deux téléchargements simultanés se partageraient la bande
/// passante pour finir plus tard tous les deux, et consommeraient deux réservations sur les
/// cinq disponibles.
final class LanguageAssetInstaller: @unchecked Sendable {
  static let shared = LanguageAssetInstaller()

  private let lock = NSLock()
  private var observer: AssetInstallObserver?
  private var task: Task<Void, Never>?
  /// La langue en cours, s'il y en a une. Sert aussi de garde contre un second démarrage.
  private var current: String?

  /// - Parameter observer: le rappel qui reçoit les évènements, ou `nil` pour le débrancher.
  func setObserver(_ observer: AssetInstallObserver?) {
    lock.lock()
    defer { lock.unlock() }
    self.observer = observer
  }

  /// La langue dont l'installation est en cours, ou `nil`.
  var inFlight: String? {
    lock.lock()
    defer { lock.unlock() }
    return current
  }

  /// Démarre l'installation et rend la main immédiatement : le téléchargement se poursuit en
  /// tâche de fond et se raconte par évènements.
  ///
  /// - Parameter language: le code de la langue, dans le périmètre du produit.
  /// - Throws: `BridgeError.audio` si la langue est hors périmètre ou si une installation est
  ///   déjà en cours.
  func start(language: String) throws {
    guard supportedLanguages.contains(language) else {
      throw BridgeError.audio("la langue « \(language) » n'est pas dans le périmètre")
    }
    lock.lock()
    guard current == nil else {
      let running = current ?? language
      lock.unlock()
      throw BridgeError.audio("une installation est déjà en cours (\(running))")
    }
    current = language
    lock.unlock()

    task = Task.detached { [weak self] in
      await self?.install(language: language)
    }
  }

  /// Demande l'arrêt de l'installation en cours.
  ///
  /// Sans effet si rien ne tourne — appelable sur un chemin d'erreur sans avoir à savoir où
  /// l'on en était.
  func cancel() {
    lock.lock()
    let running = task
    lock.unlock()
    running?.cancel()
  }

  // MARK: - Le travail

  /// - Parameter language: le code de la langue demandée.
  /// - Returns: la locale que le moteur accepte pour cette langue, ou `nil`.
  @available(macOS 26.0, *)
  private func resolve(_ language: String) async -> Locale? {
    // ⚠️ Une sous-étiquette est refusée par le moteur (« unsupported locale ») : c'est
    // `supportedLocale(equivalentTo:)` qui désigne la variante retenue par Apple. Ne pas
    // écrire les identifiants en dur — la variante n'est pas devinable et peut changer.
    await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: language))
  }

  /// Libère la place pour une installation suivante.
  ///
  /// - Warning: ⚠️ une méthode à part, et non un `defer` verrouillant directement :
  ///   `NSLock.lock()` est indisponible depuis un contexte asynchrone (erreur en mode
  ///   Swift 6). L'envelopper dans une fonction synchrone garantit que le verrou n'est jamais
  ///   tenu à travers une suspension.
  private func finish() {
    lock.lock()
    defer { lock.unlock() }
    current = nil
    task = nil
  }

  /// Déroule l'installation et n'en rend compte que par évènements.
  ///
  /// - Parameter language: le code de la langue à installer.
  private func install(language: String) async {
    defer { finish() }

    guard #available(macOS 26.0, *) else {
      emit(
        .failed(
          language: language,
          message: "cette version de macOS n'installe pas les ressources de transcription"))
      return
    }

    guard let locale = await resolve(language) else {
      emit(
        .failed(
          language: language,
          message: "la langue « \(language) » n'est pas prise en charge par le moteur d'Apple"))
      return
    }

    // ⚠️ Le quota se vérifie avant de demander, jamais après l'échec :
    // `assetInstallationRequest` réserve la locale au passage, et au sixième appel elle lève
    // « Too many allocated locales, 5 maximum » — un message d'Apple, en anglais, qui
    // remonterait tel quel à quelqu'un qui lit dans six langues. D'où le cas typé `.full`.
    // ⚠️ Une locale déjà réservée ne consomme rien de plus : sans cette exception, réinstaller
    // une langue qu'on possède déjà serait refusé alors qu'elle ne demande aucune place.
    let reserved = await AssetInventory.reservedLocales
    if !reserved.contains(where: { $0.identifier == locale.identifier })
      && reserved.count >= AssetInventory.maximumReservedLocales
    {
      emit(.full(language: language))
      return
    }

    let transcriber = SpeechTranscriber(locale: locale, preset: .progressiveTranscription)
    let request: AssetInstallationRequest?
    do {
      // ⚠️ C'est cet appel qui réserve la locale : ce n'est pas une lecture, on ne s'en sert
      // jamais pour sonder. Sonder les six langues épuiserait le quota avant le premier
      // téléchargement — et il rend une requête non nulle même pour une langue installée.
      request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber])
    } catch {
      emit(.failed(language: language, message: bridgeMessage(error)))
      return
    }

    guard let request else {
      // ⚠️ Une demande nulle ne veut pas dire « déjà installée », c'est mesuré : demander
      // l'espagnol rendait `nil`, le succès était annoncé, puis le moteur refusait d'ouvrir
      // une session faute de ressources. On ne déduit rien de `nil` : on va regarder.
      await announce(
        language: language, locale: locale,
        whenAbsent: "aucune ressource à installer n'a été proposée pour cette langue")
      return
    }

    let watcher = watchProgress(request.progress, language: language)
    defer { watcher.invalidate() }

    do {
      try await request.downloadAndInstall()
      // 100 % explicite : la dernière notification KVO peut arriver avant la fin réelle, et
      // une barre figée à 98 % au moment où l'on annonce le succès se remarque.
      emit(.progress(language: language, fraction: 1))
      // ⚠️ `downloadAndInstall()` qui rend la main n'est pas une preuve d'installation : c'est
      // `announce` qui va lire l'état réel du moteur. Aucune libération sur ce chemin —
      // libérer la réservation fait perdre le pack sur-le-champ, mesuré
      // (`src-tauri/tests/locale_reservations.rs`).
      // ⚠️ À ne pas confondre avec l'expiration : macOS retire une réservation de lui-même au
      // bout de quelques heures, et le pack, lui, survit.
      await announce(
        language: language, locale: locale,
        whenAbsent: "le téléchargement s'est terminé sans installer les ressources")
    } catch is CancellationError {
      await release(locale)
      emit(.cancelled(language: language))
    } catch {
      await release(locale)
      // ⚠️ Une annulation peut aussi remonter en `NSError` (`NSUserCancelledError`) selon
      // l'étage qui l'observe : sans cette branche, un abandon volontaire s'afficherait à
      // l'utilisateur comme une panne.
      if Task.isCancelled || (error as NSError).code == NSUserCancelledError {
        emit(.cancelled(language: language))
      } else {
        emit(.failed(language: language, message: bridgeMessage(error)))
      }
    }
  }

  /// Rend la réservation d'une locale, sur les seuls chemins d'annulation et d'échec.
  ///
  /// - Parameter locale: la locale réservée.
  @available(macOS 26.0, *)
  private func release(_ locale: Locale) async {
    _ = await AssetInventory.release(reservedLocale: locale)
  }

  /// Annonce le résultat d'après l'état réel du moteur, jamais d'après le retour d'un appel.
  ///
  /// - Parameters:
  ///   - locale: la locale dont on vérifie la présence.
  ///   - reason: le message d'échec si les ressources restent absentes.
  /// - Warning: ⚠️ `SpeechTranscriber.installedLocales` est la seule source de vérité, et
  ///   c'est celle que `SpeechEngine.prepare` consulte avant d'ouvrir une session. Annoncer un
  ///   succès sur un autre critère, c'est promettre une dictée que le moteur refusera ensuite.
  @available(macOS 26.0, *)
  private func announce(language: String, locale: Locale, whenAbsent reason: String) async {
    let installed = await SpeechTranscriber.installedLocales
      .contains { $0.language.languageCode == locale.language.languageCode }
    // ⚠️ Rien n'est libéré après un succès : ce que l'application installe puis libère
    // disparaît de la machine, mesuré — seules les locales système survivent, et Apple donne
    // ces modèles pour des actifs partagés que l'OS peut supprimer. Conséquence assumée : le
    // plafond de cinq réservations est réel, et l'interface doit le dire.
    if installed {
      emit(.installed(language: language))
    } else {
      emit(.failed(language: language, message: reason))
    }
  }

  /// Suit `Progress` par KVO et n'émet qu'au changement de point de pourcentage.
  ///
  /// `fractionCompleted` change des milliers de fois sur un téléchargement de plusieurs
  /// gigaoctets : relayer chaque notification ferait autant d'allers-retours IPC pour une
  /// barre qui n'a que 100 positions visibles.
  ///
  /// - Returns: l'observation, à invalider quand l'installation se termine.
  /// - Warning: ⚠️ le compteur vit dans un objet verrouillé, jamais dans une `var` capturée :
  ///   KVO notifie depuis un fil quelconque, et un *check-then-set* non atomique laisserait
  ///   passer deux notifications simultanées.
  private func watchProgress(_ progress: Progress, language: String) -> NSKeyValueObservation {
    let gate = PercentGate()
    return progress.observe(\.fractionCompleted, options: [.initial, .new]) {
      [weak self] progress, _ in
      guard gate.admits(Int(progress.fractionCompleted * 100)) else { return }
      self?.emit(.progress(language: language, fraction: progress.fractionCompleted))
    }
  }

  /// Pousse un évènement à l'observateur, s'il y en a un.
  private func emit(_ event: AssetInstallEvent) {
    lock.lock()
    let observer = self.observer
    lock.unlock()
    guard let observer else { return }
    // ⚠️ La chaîne ne survit pas à l'appel : Rust la copie immédiatement. Voir
    // `on_asset_install_event` côté Rust.
    event.json.withCString { observer($0) }
  }
}

// MARK: - Exports — voir la marche à suivre en tête de Bridge.swift

/// Branche l'observateur qui recevra les évènements d'installation.
///
/// - Returns: `statusOK`.
@_cdecl("mirmalion_assets_set_observer")
public func mirmalionAssetsSetObserver(
  _ observer: AssetInstallObserver?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    LanguageAssetInstaller.shared.setObserver(observer)
    return "{}"
  }
}

/// Lance l'installation des ressources d'une langue.
///
/// - Parameter language: le code de la langue, dans le périmètre du produit.
/// - Returns: `statusOK`, ou `statusError` avec le message dans `out`.
@_cdecl("mirmalion_install_language")
public func mirmalionInstallLanguage(
  _ language: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let language, let name = String(validatingCString: language) else {
      throw BridgeError.invalidArgument("langue absente ou illisible")
    }
    try LanguageAssetInstaller.shared.start(language: name)
    return "{}"
  }
}

/// Demande l'arrêt de l'installation en cours. Sans effet si rien ne tourne.
///
/// - Returns: `statusOK`.
@_cdecl("mirmalion_cancel_language_install")
public func mirmalionCancelLanguageInstall(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    LanguageAssetInstaller.shared.cancel()
    return "{}"
  }
}

/// Écrit dans `out` la langue dont l'installation est en cours.
///
/// Sert à l'écran qui s'ouvre pendant un téléchargement déjà lancé : sans cette lecture, il
/// afficherait « non installée » avec un bouton qui relancerait tout.
///
/// - Returns: `statusOK`, ou `statusNotFound` si aucune installation ne tourne.
@_cdecl("mirmalion_language_install_in_flight")
public func mirmalionLanguageInstallInFlight(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withOptionalBridgeResult(out) {
    LanguageAssetInstaller.shared.inFlight
  }
}

// MARK: - Réservations — lire, et rendre
//
// ⚠️ Le plafond de cinq ne porte pas sur les langues utilisables mais sur les réservations que
// l'application détient : une langue déjà présente sur la machine n'en consomme aucune, on ne
// l'a jamais demandée. Éteindre une langue doit rendre sa place.

/// Ne laisse passer qu'une fois par point de pourcentage, depuis n'importe quel fil.
///
/// `@unchecked Sendable` est justifié : le seul état mutable est `last`, jamais touché hors du
/// verrou.
///
/// - Warning: ⚠️ la comparaison et l'écriture sont sous le même verrou. Les séparer — lire,
///   décider, puis écrire — laisserait deux notifications KVO concurrentes conclure toutes les
///   deux que le pourcentage a changé, et émettre deux fois.
private final class PercentGate: @unchecked Sendable {
  private let lock = NSLock()
  private var last = -1

  /// - Parameter percent: le pourcentage observé.
  /// - Returns: vrai s'il diffère du dernier admis.
  func admits(_ percent: Int) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard percent != last else { return false }
    last = percent
    return true
  }
}

/// Écrit dans `out` les réservations détenues par l'application et le plafond de la machine.
///
/// - Returns: `statusOK`, ou `statusError` avec le message dans `out`.
@_cdecl("mirmalion_locale_reservations")
public func mirmalionLocaleReservations(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard #available(macOS 26.0, *) else {
      throw BridgeError.audio("cette version de macOS ne réserve aucune locale")
    }
    let locales = try awaiting("les langues réservées", within: BridgeDeadline.speechAssets) {
      await AssetInventory.reservedLocales.map { $0.identifier(.bcp47) }
    }
    let reserved = locales.map { "\"\($0)\"" }.joined(separator: ",")
    return "{\"reserved\":[\(reserved)],\"maximum\":\(AssetInventory.maximumReservedLocales)}"
  }
}

/// Rend la réservation d'une langue. Sans effet si elle n'en détenait pas.
///
/// - Parameter language: le code de la langue à libérer.
/// - Returns: `statusOK`, ou `statusError` avec le message dans `out`.
/// - Warning: ⚠️ ne prétend pas désinstaller : ce que macOS fait ensuite du pack téléchargé
///   n'est garanti par aucune documentation d'Apple.
@_cdecl("mirmalion_release_locale")
public func mirmalionReleaseLocale(
  _ language: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    guard let language, let name = String(validatingCString: language) else {
      throw BridgeError.invalidArgument("langue absente ou illisible")
    }
    guard #available(macOS 26.0, *) else {
      throw BridgeError.audio("cette version de macOS ne réserve aucune locale")
    }
    try awaiting("la libération d'une langue", within: BridgeDeadline.speechAssets) {
      // ⚠️ La variante retenue par Apple, jamais l'étiquette brute — voir `resolve`.
      if let locale = await SpeechTranscriber.supportedLocale(
        equivalentTo: Locale(identifier: name)
      ) {
        await AssetInventory.release(reservedLocale: locale)
      }
    }
    return "{}"
  }
}
