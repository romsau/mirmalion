# Cibler un navigateur comme source audio du Direct — regrouper les processus par application

> *Porteur, 2026-08-13* : « Dans la page de direct, quand on choisit la source audio, je vois une
> liste de possibilités comme certains de mes logiciels de musique… Serait-il possible de pouvoir
> choisir et cibler dans cette liste Chrome ? »

**Ce fichier n'est pas une fiche de tâche. C'est un dépôt de mesures.** La question a été
instruite le 2026-08-13, la cause est **mesurée**, la solution est dessinée et ses limites sont
connues. Rien de ce qui suit n'est à refaire. Reporté en v2 avec le cas Safari, qui demande une
autre piste.

## Le constat, et il n'est pas « Chrome est absent »

`Google Chrome` (pid 60226) **n'a aucun objet audio Core Audio**. Il n'émet rien lui-même : son
son sort de processus auxiliaires. Relevé sur la machine du porteur, Chrome 150 :

| pid | `NSRunningApplication.localizedName` | parent | notre filtre |
| --- | --- | --- | --- |
| 60226 | Google Chrome | `launchd` | *n'apparaît pas dans la liste des objets audio* |
| 60257 | *(aucun)* | Google Chrome (60226) | **jeté** |
| 60258 | « Google Chrome Helper » | Google Chrome (60226) | **affiché** |

`emittingAudioSources()` (`SystemAudioTap.swift`) ne garde que ce que `NSRunningApplication` sait
nommer — règle écrite pour écarter `coreaudiod` et les démons, qui n'ont ni nom lisible ni icône.
Elle a un effet de bord : **elle jette la moitié de Chrome, et affiche l'autre moitié sous un nom
que personne ne rattache à Chrome.**

⚠️⚠️ **LE DÉFAUT N'EST DONC PAS UNE ABSENCE, C'EST UN PIÈGE.** Choisir « Google Chrome Helper »
cible **un** des deux processus, sans aucun moyen de savoir si c'est celui qui porte le son de la
visio. Une session peut sortir **muette** sans qu'aucun message ne l'explique — et l'utilisateur ne
s'en aperçoit qu'à l'arrêt.

## Le mécanisme retenu — deux pièces, et l'API en prévoit déjà une

1. **Regrouper par application propriétaire.** Pour chaque processus qui émet, remonter la chaîne
   des parents (`sysctl` `KERN_PROC_PID` → `kp_eproc.e_ppid`) jusqu'au **dernier ancêtre nommable**
   avant `launchd`. 60257 et 60258 remontent tous les deux à « Google Chrome » : une seule ligne
   dans le menu, sous le bon nom.
2. **Capter les N processus d'un coup.** `CATapDescription(stereoMixdownOfProcesses:)` prend
   **déjà un tableau** — on lui en passe aujourd'hui un d'un seul élément
   (`targetProcess`, `SystemAudioTap.swift`). Le passage à plusieurs est une bascule, pas une
   réécriture.

L'identifiant qui traverse le pont resterait le **pid de l'application propriétaire** (60226), et
les descendants seraient **re-résolus au démarrage** de la capture, pas à l'ouverture du menu.
⚠️ **Et en prenant tous ceux qui portent un objet audio, même silencieux à cet instant** : un
onglet qui se met à jouer après « Démarrer » est ainsi couvert.

Surfaces concernées : `emittingAudioSources()` et `targetProcess` dans `SystemAudioTap.swift`,
`AudioSource` dans `src-tauri/src/commands/system_audio.rs`.

## ⚠️ La règle a été vérifiée SÛRE avant d'être proposée

Le risque évident d'une remontée de parents est de **fusionner deux applications sans rapport**.
Il ne se présente pas : toutes les applications ordinaires de la liste relevée — WhatsApp (28295),
PS Remote Play (12770), Centre de contrôle (624), les deux agents Native Instruments (985, 987),
`loginwindow` (412) — ont **`launchd` (ppid 1) pour parent** et se résolvent donc **sur
elles-mêmes**.

Le regroupement ne s'active que là où il existe une **vraie filiation**, c'est-à-dire exactement le
cas Chromium. Le même correctif donnerait donc aussi **Slack, Teams, Discord, VS Code**, qui
forkent leurs auxiliaires de la même façon.

## Les trois limites, connues et mesurées

- ⚠️⚠️ **SAFARI NE MARCHERAIT PAS, ET C'EST STRUCTUREL.** Ses processus WebKit sont lancés par
  **XPC**, donc parentés à `launchd` : mesuré, `com.apple.WebKit.GPU` (34232 et 53938) ont tous
  deux `ppid = 1`. **Aucune remontée de parents ne les rattache à Safari.** Il faudrait un autre
  mécanisme — noter que macOS les nomme d'après leur client (« *app* Graphics and Media » pour
  notre propre webview), mais s'appuyer sur un suffixe de nom serait fragile et n'a pas été
  éprouvé. **C'est ce cas qui a fait reporter le sujet en v2.**
- ⚠️ **La granularité reste l'application, pas l'onglet.** Cibler Chrome capte Chrome en entier,
  Spotify dans un autre onglet compris. C'est déjà écrit hors périmètre dans `CLAUDE.md`
  (« extension navigateur : la granularité de capture est l'application, pas l'onglet ») ; ici cela
  se voit à l'usage.
- ⚠️ **Un processus NÉ après « Démarrer » échappe au tap.** La re-résolution au démarrage réduit
  beaucoup le risque, elle ne l'élimine pas. **« Tout le système » reste le choix qui ne peut pas
  rater**, et il doit le rester.

## ⚠️⚠️ Un défaut ouvert, tranché au passage par la même mesure

`excludedFromGlobalTap()` porte cette note : *« le bip est joué par un `Audio` du webview, et
WebKit rend son son depuis un processus séparé […] Exclure notre seul `pid` pourrait donc ne rien
changer. Ne pas supposer que c'est réglé sans avoir relu une enveloppe. »*

**La sonde répond, et la réponse est non.** Nos deux processus sont bien distincts dans la liste
des objets audio — `app` (33997) et `app Graphics and Media` (34232, un `com.apple.WebKit.GPU`) —
et le second est parenté à `launchd`. **Notre exclusion, qui ne porte que sur notre pid, ne le
couvre pas.** Les deux issues déjà envisagées dans le code tiennent toujours : jouer les bips
**nativement** (donc depuis le processus exclu), ou les jouer **avant** l'ouverture du tap.

⚠️ C'est un sujet **séparé** de celui de cette fiche, et il concerne la v1.

## La sonde, pour ne pas remesurer à l'aveugle

Elle n'ouvre rien et ne demande aucune autorisation — même contrat que
`mirmalion_list_audio_sources`. `swift sonde.swift` suffit.

```swift
import AudioToolbox
import AppKit
import Darwin

func objects() -> [AudioObjectID] {
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyProcessObjectList,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var size: UInt32 = 0
  guard AudioObjectGetPropertyDataSize(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
  var list = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
  guard AudioObjectGetPropertyData(
    AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &list) == noErr else { return [] }
  return list
}

func prop<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ fallback: T) -> T {
  var address = AudioObjectPropertyAddress(
    mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
  var value = fallback
  var size = UInt32(MemoryLayout<T>.size)
  guard AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value) == noErr
  else { return fallback }
  return value
}

func parentPid(_ pid: pid_t) -> pid_t {
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.size
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return -1 }
  return info.kp_eproc.e_ppid
}

/// L'ancêtre le plus proche que `NSRunningApplication` sait nommer.
/// ⚠️ La règle RETENUE est le **dernier** ancêtre nommable avant `launchd`, pas le premier :
/// sinon « Google Chrome Helper », qui est nommable, se sépare de « Google Chrome ».
func owningApp(_ pid: pid_t) -> (pid_t, String)? {
  var current = pid
  for _ in 0..<8 {
    if let name = NSRunningApplication(processIdentifier: current)?.localizedName {
      return (current, name)
    }
    let parent = parentPid(current)
    guard parent > 1 else { return nil }
    current = parent
  }
  return nil
}

for object in objects() {
  let pid = prop(object, kAudioProcessPropertyPID, pid_t(-1))
  guard pid > 0 else { continue }
  let emitting = prop(object, kAudioProcessPropertyIsRunningOutput, UInt32(0)) != 0
  let named = NSRunningApplication(processIdentifier: pid)?.localizedName ?? "— (aucune)"
  let owner = owningApp(pid).map { "\($0.1) [\($0.0)]" } ?? "— introuvable"
  print("\(pid)\t\(emitting ? "ÉMET" : "muet")\t\(named)\t| parent \(parentPid(pid))\t| \(owner)")
}
```

⚠️ **La sonde ci-dessus applique la règle du PREMIER ancêtre nommable**, celle qui a servi au
relevé et qui sépare encore 60258 de Chrome. C'est en la lisant qu'on a vu qu'il fallait le
**dernier** — c'est le commentaire de `owningApp` qui porte la correction, pas le code.
