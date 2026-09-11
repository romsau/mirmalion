-- Schéma v1 : dictée, dictionnaire personnel, réunions, répertoire de voix.
--
-- Tout le schéma est créé ici, y compris les tables que le produit n'utilisera que plus tard.
-- Les dates sont en ISO 8601 UTC stockées en TEXT : comparable lexicographiquement, donc
-- triable et filtrable sans conversion.
--
-- Pièges
--
-- ⚠️ Aucune donnée d'audio brut n'entre en base. L'audio d'une session est un fichier
--    temporaire en cache, supprimé après consolidation.
-- ⚠️ `voices` et `meeting_participants` ont été retirées par `004_drop_voices.sql`. Cette
--    migration reste telle quelle : elle a déjà été appliquée sur des machines.

-- Le répertoire de voix : une empreinte vocale par personne, jamais l'audio.
-- Retirée par `004_drop_voices.sql` ; le produit n'y a jamais écrit une ligne.
CREATE TABLE voices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  display_name TEXT NOT NULL,
  embedding    BLOB NOT NULL,
  created_at   TEXT NOT NULL
);

-- L'historique de dictée, à rétention par nombre : 50 / 100 / 200 / 500, défaut 200, FIFO.
CREATE TABLE dictations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at          TEXT NOT NULL,
  language            TEXT NOT NULL,
  raw_text            TEXT NOT NULL,
  cleaned_text        TEXT,
  rephrased_text      TEXT,
  translated_text     TEXT,
  translated_language TEXT
);

-- L'historique se lit du plus récent au plus ancien et la purge FIFO cherche les plus
-- anciennes : le même index sert les deux.
CREATE INDEX idx_dictations_created_at ON dictations (created_at DESC);

-- Le dictionnaire personnel : un terme correct, et les variantes que le STT produit à sa place.
CREATE TABLE dictionary_terms (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  term       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE dictionary_variants (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id INTEGER NOT NULL REFERENCES dictionary_terms (id) ON DELETE CASCADE,
  variant TEXT NOT NULL,
  UNIQUE (term_id, variant)
);

CREATE INDEX idx_dictionary_variants_term_id ON dictionary_variants (term_id);

-- Les réunions, à rétention par durée, défaut 6 mois. Seul du texte est persisté.
-- Renommée `live_sessions` par `003_live_rename.sql`, puis reformée par `005`.
CREATE TABLE meetings (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  title               TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  duration_seconds    INTEGER NOT NULL,
  language            TEXT NOT NULL,
  transcript          TEXT NOT NULL,
  summary             TEXT,
  translated_summary  TEXT,
  translated_language TEXT
);

-- Sert l'historique récent-d'abord et la purge par ancienneté.
CREATE INDEX idx_meetings_started_at ON meetings (started_at DESC);

CREATE TABLE meeting_participants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id    INTEGER NOT NULL REFERENCES meetings (id) ON DELETE CASCADE,
  -- L'étiquette anonyme de la diarisation : « Locuteur 1 ». Toujours présente.
  speaker_label TEXT NOT NULL,
  -- Le nom donné par l'utilisateur, s'il en a donné un.
  display_name  TEXT,
  -- Rattachement au répertoire de voix, seulement si l'utilisateur l'a accepté.
  -- ⚠️ `ON DELETE SET NULL` : oublier une voix ne doit pas effacer la réunion.
  voice_id      INTEGER REFERENCES voices (id) ON DELETE SET NULL,
  UNIQUE (meeting_id, speaker_label)
);

CREATE INDEX idx_meeting_participants_meeting_id ON meeting_participants (meeting_id);
CREATE INDEX idx_meeting_participants_voice_id ON meeting_participants (voice_id);
