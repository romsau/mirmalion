import AVFoundation
import CoreAudio
import Foundation

// La capture micro. Deux API, deux rôles : Core Audio (HAL) énumère et désigne le défaut
// système sans rien ouvrir ni demander, AVAudioEngine capture. La HAL est le seul moyen
// d'obtenir `kAudioHardwarePropertyDefaultInputDevice` — AVFoundation ne dit pas *lequel*
// de ses périphériques est le défaut.
//
// Le flux PCM va d'ici au moteur de transcription, tous deux en Swift : aucun échantillon
// ne franchit le pont. Rust pilote — démarre, arrête, choisit le périphérique, lit l'état —
// il ne transporte pas l'audio.
//
// ⚠️ Rien n'est écrit sur le disque : ni fichier temporaire, ni tampon de secours. L'audio
// brut n'est pas conservé au-delà du nécessaire à la transcription.

/// Une entrée audio disponible, telle que l'interface la présentera.
private struct InputDevicePayload: Encodable {
  /// L'`AudioDeviceID` de Core Audio, en texte — il traverse le pont comme identifiant opaque.
  let id: String
  let name: String
  /// Vrai pour l'entrée que macOS utilise par défaut : exactement une l'est, sauf machine
  /// sans aucune entrée.
  let isDefault: Bool
}

/// L'état de la capture, tel que Rust peut le lire à tout moment.
struct CaptureStatusPayload: Encodable {
  let running: Bool
  /// L'entrée réellement utilisée — pas celle demandée. Les deux diffèrent après un repli.
  let deviceId: String?
  let deviceName: String?
  /// Le nombre d'échantillons captés depuis le démarrage : c'est la preuve que le flux
  /// coule. Un `running: true` avec un compteur figé est un micro muet, pas une capture.
  let capturedFrames: UInt64
  let sampleRate: Double
}

/// Lit une propriété de la HAL dans une valeur de taille fixe.
///
/// Visible dans tout le module : `SystemAudioTap.swift` lit les mêmes propriétés sur les
/// processus et sur le device de sortie.
///
/// - Parameters:
///   - object: l'objet HAL interrogé, `selector` et `scope` désignant la propriété voulue.
///   - fallback: la valeur rendue si la lecture échoue.
/// - Returns: la valeur lue, ou `fallback`.
func hardwareProperty<T: BitwiseCopyable>(
  _ object: AudioObjectID,
  _ selector: AudioObjectPropertySelector,
  _ scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
  default fallback: T
) -> T {
  var address = AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: scope,
    mElement: kAudioObjectPropertyElementMain
  )
  var value = fallback
  var size = UInt32(MemoryLayout<T>.size)
  let status = AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value)
  return status == noErr ? value : fallback
}

/// Lit une propriété de la HAL dont la valeur est une chaîne Core Foundation.
///
/// - Returns: la chaîne lue, ou `nil` si la HAL n'en donne pas.
/// - Warning: ⚠️ `Unmanaged` et non `CFString` : la HAL écrit dans la mémoire qu'on lui donne un
///   pointeur **déjà retenu**, sans rien relâcher de ce qui s'y trouvait. Une variable `CFString`
///   passée en `&` ferait entrer ARC dans un décompte qu'il n'a pas commencé — d'où
///   `takeRetainedValue`, qui reprend la référence que la HAL vient de céder.
func hardwareStringProperty(
  _ object: AudioObjectID,
  _ selector: AudioObjectPropertySelector
) -> String? {
  var address = AudioObjectPropertyAddress(
    mSelector: selector,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var value: Unmanaged<CFString>?
  var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr,
    let string = value?.takeRetainedValue()
  else {
    return nil
  }
  return string as String
}

/// Le nom lisible d'un périphérique, ou `nil` s'il ne s'en donne pas.
func deviceName(_ device: AudioDeviceID) -> String? {
  hardwareStringProperty(device, kAudioObjectPropertyName)
}

/// Le périphérique a-t-il au moins un canal d'entrée ?
///
/// - Warning: ⚠️ c'est le filtre qui distingue une entrée d'une sortie. La HAL rend *tous*
///   les périphériques, haut-parleurs compris ; seul le nombre de canaux dans le scope
///   d'entrée les sépare. Sans ce test, le sélecteur de micro listerait les enceintes.
private func hasInputChannels(_ device: AudioDeviceID) -> Bool {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioDevicePropertyStreamConfiguration,
    mScope: kAudioObjectPropertyScopeInput,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr, size > 0 else {
    return false
  }

  let buffer = UnsafeMutableRawPointer.allocate(
    byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
  defer { buffer.deallocate() }
  guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, buffer) == noErr else {
    return false
  }

  let list = UnsafeMutableAudioBufferListPointer(
    buffer.assumingMemoryBound(to: AudioBufferList.self))
  return list.contains { $0.mNumberChannels > 0 }
}

/// Le défaut système, ou `kAudioObjectUnknown` sur une machine sans entrée.
private func defaultInputDevice() -> AudioDeviceID {
  hardwareProperty(
    AudioObjectID(kAudioObjectSystemObject),
    kAudioHardwarePropertyDefaultInputDevice,
    default: AudioDeviceID(kAudioObjectUnknown)
  )
}

/// Toutes les entrées audio de la machine, dans l'ordre que rend la HAL.
private func inputDevices() -> [(id: AudioDeviceID, name: String)] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDevices,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain
  )
  var size: UInt32 = 0
  let system = AudioObjectID(kAudioObjectSystemObject)
  guard AudioObjectGetPropertyDataSize(system, &address, 0, nil, &size) == noErr else {
    return []
  }

  let count = Int(size) / MemoryLayout<AudioDeviceID>.size
  guard count > 0 else { return [] }

  var devices = [AudioDeviceID](repeating: AudioDeviceID(kAudioObjectUnknown), count: count)
  guard AudioObjectGetPropertyData(system, &address, 0, nil, &size, &devices) == noErr else {
    return []
  }

  return devices.filter(hasInputChannels).compactMap { device in
    deviceName(device).map { (id: device, name: $0) }
  }
}

/// La capture micro : un moteur, un périphérique, un compteur.
///
/// Une seule instance, partagée par tous les appels du pont (`sharedCapture`) : deux moteurs
/// sur le même micro se disputeraient le périphérique, et la dictée est mono-source.
///
/// `@unchecked Sendable` : tout l'état mutable est gardé par `lock`. Les tampons audio
/// arrivent sur un fil temps réel de CoreAudio, les commandes depuis un fil de travail de
/// Rust — les deux se croisent, et c'est le verrou qui les sépare.
final class AudioCapture: @unchecked Sendable {
  private let lock = NSLock()
  private let engine = AVAudioEngine()

  private var running = false
  private var device: AudioDeviceID = AudioDeviceID(kAudioObjectUnknown)
  private var capturedFrames: UInt64 = 0
  private var sampleRate: Double = 0

  /// Ce que l'utilisateur a demandé — `nil` quand il suit le défaut système.
  ///
  /// - Warning: ⚠️ distinct du périphérique réellement utilisé : après un débranchement on
  ///   bascule sur le défaut système sans oublier le choix de l'utilisateur. Rebrancher ses
  ///   AirPods doit les reprendre, pas exiger qu'il les resélectionne.
  private var requested: AudioDeviceID?

  /// Le puits des tampons PCM — branché par le moteur de transcription.
  ///
  /// Une fermeture et non un protocole : un puits absent est un cas nominal, ce qui permet de
  /// démarrer la capture sans moteur de transcription branché.
  private var sink: ((AVAudioPCMBuffer) -> Void)?

  /// Crée la capture et arme le repli sur le micro système.
  init() {
    // ⚠️ AVAudioEngine émet cette notification quand sa configuration change sous ses pieds —
    // des AirPods qui se déconnectent en pleine dictée, typiquement. Sans réaction, le moteur
    // reste « démarré » sur un périphérique disparu et ne produit plus un seul échantillon,
    // en silence.
    NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange,
      object: engine,
      queue: nil
    ) { [weak self] _ in
      self?.recoverFromConfigurationChange()
    }
  }

  /// Branche — ou débranche — le consommateur des tampons.
  ///
  /// - Parameter sink: le puits, ou `nil` pour le débrancher.
  /// - Warning: ⚠️ à poser avant `start`, à retirer après `stop`. Changer le puits en cours
  ///   de capture est licite (le verrou le protège) mais fait perdre les tampons en vol, ce
  ///   qui se traduit par des mots mangés en début de dictée.
  func setSink(_ sink: ((AVAudioPCMBuffer) -> Void)?) {
    lock.lock()
    defer { lock.unlock() }
    self.sink = sink
  }

  /// Démarre la capture sur `deviceId`, ou sur le défaut système si `nil`.
  ///
  /// Redémarrer alors qu'une capture tourne est accepté et vaut changement de périphérique :
  /// c'est exactement le geste du sélecteur de micro.
  ///
  /// - Parameter deviceId: le périphérique voulu, `nil` pour suivre le défaut système.
  /// - Throws: `BridgeError.permission` si le micro n'est pas autorisé — on lit l'état, on ne
  ///   s'essaie pas à ouvrir ; `BridgeError.audio` si l'entrée ne peut pas être ouverte.
  func start(deviceId: AudioDeviceID?) throws {
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
      throw BridgeError.permission("le micro n'est pas autorisé, la capture n'a pas été ouverte")
    }

    lock.lock()
    defer { lock.unlock() }

    requested = deviceId
    try restart(on: deviceId ?? defaultInputDevice())
  }

  /// Arrête la capture et oublie le périphérique demandé. Sans effet si rien ne tourne.
  func stop() {
    lock.lock()
    defer { lock.unlock() }
    teardown()
    requested = nil
  }

  /// - Returns: l'état courant de la capture, lisible à tout moment.
  func status() -> CaptureStatusPayload {
    lock.lock()
    defer { lock.unlock() }

    return CaptureStatusPayload(
      running: running,
      deviceId: running ? String(device) : nil,
      deviceName: running ? deviceName(device) : nil,
      capturedFrames: capturedFrames,
      sampleRate: sampleRate
    )
  }

  /// Ouvre le moteur sur un périphérique. À appeler verrou tenu.
  ///
  /// - Parameter target: le périphérique à ouvrir.
  /// - Throws: `BridgeError.audio` si aucune entrée n'est disponible, si la sélection échoue,
  ///   si le format est inexploitable ou si le moteur ne démarre pas.
  private func restart(on target: AudioDeviceID) throws {
    teardown()

    guard target != AudioDeviceID(kAudioObjectUnknown) else {
      throw BridgeError.audio("aucune entrée audio disponible sur cette machine")
    }

    // ⚠️ Poser le périphérique avant de lire le format d'entrée : `inputFormat` est celui du
    // périphérique courant, le lire d'abord donnerait la fréquence d'échantillonnage du
    // précédent, et le tap serait installé avec un format qui ne correspond à rien.
    var selected = target
    let unit = engine.inputNode.audioUnit
    if let unit {
      let status = AudioUnitSetProperty(
        unit,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &selected,
        UInt32(MemoryLayout<AudioDeviceID>.size)
      )
      guard status == noErr else {
        throw BridgeError.audio("l'entrée audio n'a pas pu être sélectionnée (\(status))")
      }
    }

    let format = engine.inputNode.inputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      throw BridgeError.audio("l'entrée audio ne déclare aucun format exploitable")
    }

    // `bufferSize: 0` laisse CoreAudio choisir la taille de tampon du périphérique : imposer
    // une valeur ajouterait une conversion là où le matériel a déjà tranché.
    engine.inputNode.installTap(onBus: 0, bufferSize: 0, format: format) { [weak self] buffer, _ in
      self?.consume(buffer)
    }

    do {
      try engine.start()
    } catch {
      engine.inputNode.removeTap(onBus: 0)
      throw BridgeError.audio("le moteur audio n'a pas démarré : \(bridgeMessage(error))")
    }

    device = target
    sampleRate = format.sampleRate
    capturedFrames = 0
    running = true
  }

  /// Ferme tout, sans rien signaler. À appeler verrou tenu.
  ///
  /// Idempotente à dessein : elle est appelée à l'arrêt, avant chaque redémarrage et sur
  /// repli. Supposer un moteur démarré finirait par retirer deux fois le même tap.
  private func teardown() {
    guard running else { return }
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    running = false
    sampleRate = 0
  }

  /// Un tampon PCM vient d'arriver : le compter, puis le passer au puits.
  ///
  /// - Parameter buffer: le tampon rendu par le tap.
  /// - Warning: ⚠️ fil temps réel — rien de coûteux ici.
  private func consume(_ buffer: AVAudioPCMBuffer) {
    lock.lock()
    capturedFrames &+= UInt64(buffer.frameLength)
    let sink = self.sink
    lock.unlock()

    // Hors verrou : le puits appartient au moteur de transcription, et rien ne garantit ce
    // qu'il fait. Le tenir sous notre verrou ferait dépendre le fil temps réel de son bon
    // vouloir.
    sink?(buffer)
  }

  /// La configuration du moteur a changé sous ses pieds — périphérique débranché, le plus
  /// souvent.
  ///
  /// La dictée en cours n'est pas coupée : on rouvre sur le périphérique demandé s'il est
  /// encore là, sur le défaut système sinon. Un échec ici laisse la capture arrêtée plutôt
  /// que dans un état ambigu ; l'appelant le verra au compteur figé et au `running: false`.
  private func recoverFromConfigurationChange() {
    lock.lock()
    defer { lock.unlock() }

    guard running else { return }

    let stillThere = requested.map { candidate in
      inputDevices().contains { $0.id == candidate }
    }
    let target = stillThere == true ? (requested ?? defaultInputDevice()) : defaultInputDevice()

    do {
      try restart(on: target)
    } catch {
      // Rien à signaler au pont : l'état renvoyé dira que rien ne tourne.
      teardown()
    }
  }
}

/// L'unique capture du processus, visible dans tout le module : le moteur de transcription y
/// branche son puits.
let sharedCapture = AudioCapture()

/// Écrit dans `out` la liste JSON des entrées audio disponibles.
///
/// Ne demande aucune autorisation : un sélecteur de micro doit se remplir avant que le micro
/// soit accordé.
///
/// - Returns: `statusOK`, ou `statusError` avec le message dans `out`.
/// - Warning: ⚠️ Core Audio et non AVFoundation — la HAL n'exige aucune autorisation pour
///   énumérer, et elle seule désigne le défaut système, imposé comme valeur par défaut.
@_cdecl("mirmalion_list_input_devices")
public func mirmalionListInputDevices(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    let fallback = defaultInputDevice()
    let payload = inputDevices().map { device in
      InputDevicePayload(
        id: String(device.id),
        name: device.name,
        isDefault: device.id == fallback
      )
    }

    return try bridgeJSON(payload)
  }
}

/// Démarre la capture micro.
///
/// - Parameter deviceId: l'identifiant du périphérique, vide pour le défaut système.
/// - Returns: `statusOK`, ou `statusError` avec le message dans `out`.
/// - Warning: ⚠️ refuse si le micro n'est pas autorisé : on vérifie l'état, on ne s'essaie
///   pas à ouvrir pour voir. Sans cette garde, le premier démarrage ferait surgir un prompt
///   système hors de tout clic de l'utilisateur.
@_cdecl("mirmalion_start_capture")
public func mirmalionStartCapture(
  _ deviceId: UnsafePointer<CChar>?,
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    try sharedCapture.start(deviceId: optionalArgument(deviceId).flatMap(AudioDeviceID.init))
    return ""
  }
}

/// Arrête la capture micro.
///
/// Sans effet si rien ne tourne — c'est ce qui permet de l'appeler sur un chemin d'erreur
/// sans avoir à savoir où l'on en était.
///
/// - Returns: `statusOK`.
@_cdecl("mirmalion_stop_capture")
public func mirmalionStopCapture(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    sharedCapture.stop()
    return ""
  }
}

/// Écrit dans `out` l'état JSON de la capture micro.
///
/// Le compteur d'échantillons distingue une capture qui tourne d'une capture qui croit
/// tourner : un micro coupé au niveau matériel rend un moteur démarré et un compteur figé.
///
/// - Returns: `statusOK`, ou `statusError` avec le message dans `out`.
@_cdecl("mirmalion_capture_status")
public func mirmalionCaptureStatus(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    return try bridgeJSON(sharedCapture.status())
  }
}
