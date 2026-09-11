-- Efface ce que la base garde encore de trois langues sorties du périmètre : `zh`, `ja`, `ko`.
--
-- Le code n'en connaît plus le nom. Une ligne qui porte encore l'un de ces codes s'afficherait
-- dans l'historique sans étiquette de langue, et son transcript ne pourrait plus être ni traduit
-- ni résumé — aucun moteur du périmètre ne l'accepte en entrée.
--
-- Pièges
--
-- ⚠️ La langue **parlée** emporte la ligne, la langue **cible** ne l'emporte pas : une dictée
--    française traduite vers l'une de ces langues reste une dictée française, et seule sa
--    traduction est effacée. Supprimer la ligne entière perdrait un texte que l'utilisateur a
--    dicté dans une langue toujours prise en charge.
-- ⚠️ Irréversible, et il n'y a pas de reprise : ce qui est supprimé ici l'est pour de bon.

DELETE FROM dictations WHERE language IN ('zh', 'ja', 'ko');

UPDATE dictations
   SET translated_text = NULL,
       translated_language = NULL
 WHERE translated_language IN ('zh', 'ja', 'ko');

DELETE FROM live_sessions WHERE language IN ('zh', 'ja', 'ko');

UPDATE live_sessions
   SET translation_target = NULL
 WHERE translation_target IN ('zh', 'ja', 'ko');
