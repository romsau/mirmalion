import Foundation
import Speech

// Les mots horodatés que la transcription rend à l'attribution.
//
// Deux chemins les produisent — `FileTranscription.swift` et `LiveTranscription.swift` — pour un
// seul consommateur, `diarization::attribute` côté Rust, qui rattache chaque mot à une voix.
//
// ⚠️ Les deux chemins doivent découper de la même façon : un découpage différent d'un côté rendrait
// l'attribution meilleure là que de l'autre, sans que rien ne le montre.
// ⚠️ Sans le préréglage `timeIndexedProgressiveTranscription`, `run.audioTimeRange` est nul partout
// et `timedWords` rend une liste vide — un transcript qui s'affiche mais ne s'attribue à personne.

/// Un mot et sa fenêtre de temps. Miroir de `Word` côté Rust.
struct TimedWord: Encodable {
  let text: String
  let startMs: UInt64
  let endMs: UInt64
}

/// Découpe le texte d'un passage horodaté en mots.
///
/// - Parameters:
///   - text: le texte du passage.
///   - startMs: début du passage, en millisecondes.
///   - endMs: fin du passage, en millisecondes.
/// - Returns: un `TimedWord` par mot, la fenêtre répartie au prorata du nombre de caractères.
/// - Warning: ⚠️ un passage ne porte pas toujours un seul mot ; une même fenêtre pour tous les
///   rendrait simultanés et ferait s'effondrer l'attribution des voix.
func splitTimed(text: String, from startMs: UInt64, to endMs: UInt64) -> [TimedWord] {
  let pieces = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline })
  guard !pieces.isEmpty else { return [] }
  if pieces.count == 1 {
    return [TimedWord(text: String(pieces[0]), startMs: startMs, endMs: endMs)]
  }

  let span = endMs >= startMs ? endMs - startMs : 0
  // `split` n'émet pas de morceau vide : deux morceaux au moins, un caractère au moins chacun.
  let total = pieces.reduce(0) { $0 + $1.count }

  var words: [TimedWord] = []
  var consumed = 0
  for piece in pieces {
    let from = startMs + UInt64(Double(span) * Double(consumed) / Double(total))
    consumed += piece.count
    let to = startMs + UInt64(Double(span) * Double(consumed) / Double(total))
    words.append(TimedWord(text: String(piece), startMs: from, endMs: to))
  }
  return words
}

/// Extrait les mots horodatés d'un résultat de transcription.
///
/// - Parameters:
///   - text: le texte attribué rendu par le moteur.
/// - Returns: les mots des passages horodatés, dans l'ordre.
/// - Warning: ⚠️ un passage sans `audioTimeRange` est ignoré, jamais horodaté à zéro : un mot
///   placé à l'instant 0 serait attribué à la première voix venue.
@available(macOS 26.0, *)
func timedWords(in text: AttributedString) -> [TimedWord] {
  var collected: [TimedWord] = []
  for run in text.runs {
    guard let range = run.audioTimeRange else { continue }
    let piece = String(text[run.range].characters)
    let startMs = UInt64(max(0, range.start.seconds * 1_000))
    let endMs = UInt64(max(0, range.end.seconds * 1_000))
    collected.append(contentsOf: splitTimed(text: piece, from: startMs, to: endMs))
  }
  return collected
}
