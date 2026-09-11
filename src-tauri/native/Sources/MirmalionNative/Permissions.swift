import AVFoundation
import AppKit
import ApplicationServices
import CoreAudio
import CoreServices
import Foundation

// Lire une permission ne doit jamais en demander une : aucun pop-up TCC ne surgit sans que
// l'utilisateur l'ait déclenché. Tout ce fichier en découle.
//
// ⚠️ La façon évidente de savoir si une permission est accordée est de s'en servir — et s'en
// servir déclenche le prompt. Chaque lecture emploie donc l'API de préflight de sa permission,
// jamais la fonctionnalité : on n'ouvre jamais le micro « pour tester », et l'Apple Event de
// sondage part avec `askUserIfNeeded: false`, qui répond sans rien demander.
//
// ⚠️ Quatre états : `unknown` dit « macOS ne permet pas de le savoir sans déclencher la
// chose », et il n'y a qu'un cas, l'Enregistrement audio (voir `audioCapturePermission`). Le
// confondre avec `denied` afficherait « refusé » à qui n'a rien refusé ; avec `notDetermined`,
// cela promettrait un prompt qu'on ne sait pas déclencher.

/// Accordée : la fonction peut s'exécuter.
private let permissionGranted = "granted"
/// Refusée. ⚠️ Aucune API ne peut re-demander : il faut passer par les Réglages Système.
private let permissionDenied = "denied"
/// Jamais demandée. C'est le seul état où un prompt peut encore partir.
private let permissionNotDetermined = "notDetermined"
/// macOS n'expose aucun moyen de le savoir sans déclencher l'opération elle-même.
private let permissionUnknown = "unknown"

/// L'identifiant de System Events, cible de tout Apple Event d'automatisation et sujet du
/// préflight d'`automationPermission()`.
private let systemEventsBundleID = "com.apple.systemevents"

/// La clé d'option d'`AXIsProcessTrustedWithOptions`, écrite en toutes lettres.
///
/// - Warning: ⚠️ Pas `kAXTrustedCheckOptionPrompt` : Swift 6 importe cette constante comme un
///   `var` global et refuse de la lire, « non sûre pour la concurrence ». La chaîne ci-dessous
///   en est la valeur exacte, et elle est convertie au point d'usage — un `CFString` global
///   serait refusé lui aussi, `CFString` n'étant pas `Sendable`.
private let accessibilityPromptOption = "AXTrustedCheckOptionPrompt"

/// Le volet des Réglages Système où s'accorde l'Accessibilité, qui n'a pas de prompt : c'est
/// le seul geste possible pour l'utilisateur.
private let accessibilitySettingsURL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"

/// L'état d'une permission, tel qu'il traverse la frontière.
private struct PermissionPayload: Encodable {
  let status: String
  /// De quoi expliquer la situation. Absent quand il n'y a rien à expliquer.
  let detail: String?

  static func granted() -> Self { Self(status: permissionGranted, detail: nil) }
  static func denied(_ detail: String) -> Self { Self(status: permissionDenied, detail: detail) }
  static func notDetermined(_ detail: String? = nil) -> Self {
    Self(status: permissionNotDetermined, detail: detail)
  }
  static func unknown(_ detail: String) -> Self { Self(status: permissionUnknown, detail: detail) }
}

/// Les quatre permissions rendues par `mirmalion_permissions_status`, sérialisées en JSON.
private struct PermissionsPayload: Encodable {
  let microphone: PermissionPayload
  let accessibility: PermissionPayload
  let automation: PermissionPayload
  let audioCapture: PermissionPayload
}

/// L'état du micro, lu par `authorizationStatus` — un pur accesseur, qui ne déclenche rien.
///
/// - Returns: l'état TCC du micro ; `denied` couvre aussi le cas d'une politique d'appareil,
///   que l'utilisateur ne peut pas lever lui-même.
private func microphonePermission() -> PermissionPayload {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized:
    return .granted()
  case .denied:
    return .denied("refusée — seuls les Réglages Système peuvent la rétablir")
  case .restricted:
    return .denied(
      "interdite par une politique de l'appareil, l'utilisateur ne peut pas l'accorder")
  case .notDetermined:
    return .notDetermined()
  @unknown default:
    return .unknown("état de micro inconnu de cette version de l'app")
  }
}

/// L'état de l'Accessibilité, dont dépendent le raccourci global et le collage au curseur.
///
/// - Returns: `granted`, ou `notDetermined` — jamais `denied`.
/// - Warning: ⚠️ `AXIsProcessTrusted()` répond oui ou non : rien ne distingue « refusée » de
///   « jamais demandée ». `notDetermined` est le plus juste des deux, aucun prompt n'existant
///   et le geste attendu étant le même.
/// - Warning: ⚠️ La permission est attachée à la signature de code : une re-signature
///   l'invalide, et elle peut donc retomber après une mise à jour. Le message d'interface doit
///   l'expliquer, pas accuser l'utilisateur.
private func accessibilityPermission() -> PermissionPayload {
  AXIsProcessTrusted()
    ? .granted()
    : .notDetermined("s'accorde dans les Réglages Système ; aucun prompt n'existe")
}

/// L'état de l'automatisation : les Apple Events vers System Events.
///
/// Absente de l'accueil, qui n'en présente que trois : le collage au curseur passe par
/// `CGEvent` et n'en a pas besoin.
///
/// - Warning: ⚠️ `askUserIfNeeded: false` est ce qui rend cette lecture licite : à `true`,
///   l'appel fait surgir la pop-up de consentement. Ne pas l'inverser « pour que ça marche du
///   premier coup ».
private func automationPermission() -> PermissionPayload {
  guard let target = NSAppleEventDescriptor(bundleIdentifier: systemEventsBundleID).aeDesc else {
    return .unknown("impossible de désigner System Events")
  }
  let status = AEDeterminePermissionToAutomateTarget(target, typeWildCard, typeWildCard, false)

  switch status {
  case noErr:
    return .granted()
  case OSStatus(errAEEventNotPermitted):
    return .denied("refusée — seuls les Réglages Système peuvent la rétablir")
  case OSStatus(errAEEventWouldRequireUserConsent):
    return .notDetermined()
  case OSStatus(procNotFound):
    // ⚠️ C'est le cas courant, pas le cas rare : System Events est un agent lancé à la
    // demande, absent d'une session ordinaire, et le préflight ne peut rien dire d'un
    // processus absent. Ni refus ni accord — et on ne le lance pas pour lire son état,
    // démarrer un processus tiers à l'insu de l'utilisateur étant l'effet de bord que ce
    // fichier existe pour éviter.
    return .unknown("System Events n'est pas lancé, l'état n'est pas lisible maintenant")
  default:
    return .unknown("code d'automatisation inattendu : \(status)")
  }
}

/// L'état de l'Enregistrement audio (`NSAudioCaptureUsageDescription`), celui des sessions du
/// Direct, capté par les Core Audio Process Taps.
///
/// - Returns: toujours `unknown`, le seul du fichier.
/// - Warning: ⚠️ Cette catégorie TCC n'a aucune API de préflight publique : ni équivalent
///   d'`AVCaptureDevice.authorizationStatus`, ni lecture de la base TCC, protégée par SIP.
///   Créer un tap pour savoir déclencherait le prompt sur une simple lecture.
/// - Warning: ⚠️ Ne jamais parler d'« enregistrement de l'écran » ici : l'app ne demande
///   jamais l'accès à l'écran, et l'écrire enverrait l'utilisateur dans le mauvais volet.
private func audioCapturePermission() -> PermissionPayload {
  .unknown("macOS n'expose pas cet état sans créer un tap")
}

/// Crée un tap audio global, puis le détruit immédiatement, pour obtenir le verdict TCC.
///
/// Rien n'est capté : le tap est détruit avant qu'aucun périphérique agrégé ne lui soit
/// rattaché, et sans device agrégé un tap ne produit aucun échantillon. Il est aussi privé, donc
/// invisible dans la liste des périphériques du système.
///
/// - Warning: ⚠️ C'est une demande, pas une lecture : la création du tap déclenche le prompt.
///   Ne jamais l'appeler depuis `mirmalion_permissions_status`.
/// - Warning: ⚠️ `stereoGlobalTapButExcludeProcesses: []`, et non `stereoMixdownOfProcesses: []`
///   qui décrit un tap sur une liste vide — zéro processus, donc un sondage inopérant.
private func requestAudioCapture() -> PermissionPayload {
  let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
  description.isPrivate = true
  description.muteBehavior = .unmuted

  var tap = AudioObjectID(kAudioObjectUnknown)
  let status = AudioHardwareCreateProcessTap(description, &tap)
  guard status == noErr else {
    // Aucun code d'erreur ne distingue « refusée » de « impossible ici » : Core Audio rend le
    // même échec dans les deux cas. On dit donc « refusée », qui est le cas de très loin le
    // plus probable, et on garde le code pour le journal — jamais pour l'utilisateur.
    return .denied("refusée — Core Audio a répondu \(status)")
  }
  AudioHardwareDestroyProcessTap(tap)
  return .granted()
}

/// Encode une charge utile en JSON pour la traversée du pont.
///
/// - Parameters:
///   - payload: l'état d'une permission, ou l'inventaire complet.
/// - Returns: le JSON en UTF-8.
/// - Throws: `BridgeError.permission` si l'encodage n'est pas de l'UTF-8.
private func encoded(_ payload: some Encodable) throws -> String {
  return try bridgeJSON(payload)
}

/// Renvoie, en JSON, l'état des quatre permissions.
///
/// - Parameters:
///   - out: reçoit le JSON alloué, que l'appelant rend par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` si l'inventaire n'est pas encodable.
/// - Warning: ⚠️ Cet export ne déclenche aucun prompt, et ne doit jamais en déclencher. Le
///   schéma est repris à l'identique dans `src-tauri/src/commands/permissions.rs`.
@_cdecl("mirmalion_permissions_status")
public func mirmalionPermissionsStatus(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    try encoded(
      PermissionsPayload(
        microphone: microphonePermission(),
        accessibility: accessibilityPermission(),
        automation: automationPermission(),
        audioCapture: audioCapturePermission()
      ))
  }
}

/// Transporte la réponse de l'utilisateur du bloc de `requestAccess` vers l'appelant.
///
/// - Warning: ⚠️ Le `@unchecked Sendable` ne tient que par le sémaphore : l'écriture précède le
///   `signal()`, la lecture suit le `wait()`. Toucher `granted` hors de cet ordre perd la
///   garantie que le compilateur ne sait pas démontrer.
private final class MicrophoneAnswer: @unchecked Sendable {
  var granted = false
}

/// Demande l'accès au micro et renvoie l'état obtenu. Fait surgir un prompt, et n'est donc
/// atteint qu'au clic « Autoriser ».
///
/// - Parameters:
///   - out: reçoit le JSON de l'état obtenu, rendu par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` si l'état n'est pas encodable.
/// - Warning: ⚠️ Le `wait()` est bloquant et sans délai maximal — Rust appelle cet export
///   depuis `spawn_blocking` ; sur le fil principal, il figerait la fenêtre et le prompt.
@_cdecl("mirmalion_request_microphone")
public func mirmalionRequestMicrophone(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    // ⚠️ `requestAccess` est un no-op silencieux dès que l'état n'est plus `.notDetermined` :
    // sans cette garde, l'interface ferait croire qu'un clic rouvre un choix déjà refusé, que
    // seuls les Réglages Système peuvent rétablir.
    guard AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined else {
      return try encoded(microphonePermission())
    }

    // ⚠️ **La seule attente du pont qui ne prendra jamais de borne**, et l'absence est le
    // contrat : ce qu'on attend ici est un humain devant une boîte de dialogue. Borner ce
    // `wait` reviendrait à refuser une autorisation parce que quelqu'un a hésité, et
    // `authorizationStatus` ne la rouvrirait plus — seuls les Réglages Système le pourraient.
    // Ce n'est pas non plus le motif `awaiting` : il n'y a pas de `Task`, mais un rappel.
    let answer = MicrophoneAnswer()
    let answered = DispatchSemaphore(value: 0)
    AVCaptureDevice.requestAccess(for: .audio) { granted in
      answer.granted = granted
      answered.signal()
    }
    answered.wait()

    // ⚠️ La réponse vient du bloc, jamais d'une relecture d'`authorizationStatus` : l'accesseur
    // ne reflète pas encore l'octroi quand le bloc rend la main, et l'interface affichait
    // « Refusé » à qui venait d'accepter.
    let payload: PermissionPayload =
      answer.granted
      ? .granted()
      : .denied("refusée — seuls les Réglages Système peuvent la rétablir")
    return try encoded(payload)
  }
}

/// Demande l'Enregistrement audio et renvoie l'état obtenu. Fait surgir un prompt au premier
/// appel, et n'est donc atteint qu'au clic « Autoriser ».
///
/// Le choix fait, macOS ne réaffiche rien : « Revérifier » en rappelle le verdict sans prompt.
///
/// - Parameters:
///   - out: reçoit le JSON de l'état obtenu, rendu par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` si l'état n'est pas encodable.
/// - Warning: ⚠️ Le seul export sans garde préalable, faute de préflight à consulter. Bloquant :
///   la création du tap dialogue avec `coreaudiod` et attend la réponse de l'utilisateur.
@_cdecl("mirmalion_request_audio_capture")
public func mirmalionRequestAudioCapture(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    try encoded(requestAudioCapture())
  }
}

/// Demande l'Accessibilité : inscrit l'application dans la liste, puis ouvre le volet.
///
/// Le volet est ouvert en plus de l'alerte système, dont le bouton peut passer inaperçu.
///
/// - Parameters:
///   - out: reçoit le JSON de l'état constaté, rendu par `mirmalion_free_string`.
/// - Returns: `statusOK`, ou `statusError` si les Réglages Système ne s'ouvrent pas.
/// - Warning: ⚠️ `kAXTrustedCheckOptionPrompt` n'est pas une politesse, c'est l'inscription :
///   sans lui, l'application ne figure nulle part dans le volet, l'utilisateur n'a aucune case
///   à cocher, et `AXIsProcessTrusted()` répond « non » indéfiniment.
@_cdecl("mirmalion_request_accessibility")
public func mirmalionRequestAccessibility(
  _ out: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
) -> Int32 {
  withBridgeResult(out) {
    // ⚠️ L'option de prompt appartient à cet export, atteint sur clic explicite ;
    // `accessibilityPermission()` appelle la variante sans options, qui n'inscrit ni n'affiche
    // rien. Les intervertir ferait surgir une alerte système au simple affichage d'un écran.
    let options = [accessibilityPromptOption as CFString: true] as CFDictionary
    let trusted = AXIsProcessTrustedWithOptions(options)

    guard let url = URL(string: accessibilitySettingsURL) else {
      throw BridgeError.permission("l'adresse du volet Accessibilité est invalide")
    }
    // `NSWorkspace` plutôt qu'un `open` en sous-processus, que le sandbox refuserait. Appelable
    // depuis un fil de travail : AppKit étant audité pour la concurrence stricte de Swift 6,
    // l'absence de `@MainActor` sur `NSWorkspace.open` est une information, pas un oubli.
    guard NSWorkspace.shared.open(url) else {
      throw BridgeError.permission("les Réglages Système n'ont pas pu être ouverts")
    }

    // L'octroi ne se fait pas dans cet appel : il se constatera à la prochaine lecture, quand
    // l'utilisateur aura basculé l'interrupteur. On rend l'état tel qu'il est maintenant.
    let payload: PermissionPayload =
      trusted
      ? .granted()
      : .notDetermined("à cocher dans les Réglages Système ; aucun prompt n'existe")
    return try encoded(payload)
  }
}
