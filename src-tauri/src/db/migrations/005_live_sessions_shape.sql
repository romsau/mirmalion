-- `live_sessions` prend la forme de ce qu'une session rend vraiment.
--
-- La table datait du schéma v1, quand une session rendait du texte plat et un résumé. Un
-- transcript est désormais un `Transcript` — des paragraphes de mots horodatés —, un compte
-- rendu une suite de rubriques, et un titre peut être absent.
--
-- Pièges
--
-- ⚠️ On recrée plutôt qu'on n'altère, sans perte possible : aucune ligne n'avait jamais été
--    écrite dans cette table par le produit.
-- ⚠️ `001_initial.sql` et `003_live_rename.sql` ne sont pas touchées et ne doivent jamais
--    l'être : elles ont déjà été appliquées sur des machines.
-- ⚠️ Toujours aucun audio en base. Les deux fichiers d'une session vivent dans le cache le
--    temps de la consolidation et disparaissent avec elle, même quand elle échoue.

DROP INDEX idx_live_sessions_started_at;
DROP TABLE live_sessions;

CREATE TABLE live_sessions (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Le titre donné par l'utilisateur.
  -- ⚠️ Nullable : `NULL` veut dire « pas nommée », et le repli daté se compose à l'écran dans
  -- la langue de l'interface. L'écrire ici le figerait dans la langue du jour.
  title              TEXT,
  -- Ce qui était capté : « Microsoft Teams », « Tout le système ». Relevé au démarrage.
  source_name        TEXT NOT NULL,
  -- Le début de la session.
  -- ⚠️ C'est cette colonne que la purge regarde, pas `ended_at` : dater une session de sa fin
  -- la ferait survivre au-delà de sa rétention.
  started_at         TEXT NOT NULL,
  ended_at           TEXT NOT NULL,
  language           TEXT NOT NULL,
  -- Le `Transcript` complet, en JSON : paragraphes, mots, horodatages.
  -- ⚠️ Le mettre à plat perdrait ce dont l'export SRT et VTT a besoin ; l'éclater en tables
  -- donnerait des dizaines de milliers de lignes pour une donnée lue seulement en entier.
  transcript         TEXT NOT NULL,
  -- Les rubriques du compte rendu, en JSON.
  -- ⚠️ `NULL` veut dire qu'il n'y en a pas, et ce n'est pas un échec : le compte rendu est un
  -- geste, l'arrêt d'une session ne génère rien.
  report             TEXT,
  -- La langue vers laquelle la session a été suivie, `NULL` s'il n'y en avait pas.
  translation_target TEXT
);

-- Sert l'historique récent-d'abord et la purge par ancienneté : les deux parcourent cette
-- colonne, dans un sens et dans l'autre.
CREATE INDEX idx_live_sessions_started_at ON live_sessions (started_at DESC);
