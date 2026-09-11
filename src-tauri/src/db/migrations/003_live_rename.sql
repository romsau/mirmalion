-- « Réunion » devient « Direct » : le schéma suit le renommage du reste du code.
--
-- Pièges
--
-- ⚠️ `001_initial.sql` n'est pas touchée et ne doit jamais l'être : elle a déjà été appliquée
--    sur des machines. C'est ici qu'on renomme, pas là-bas qu'on réécrit l'histoire.
-- ⚠️ `ALTER TABLE … RENAME` ne perd rien : SQLite réécrit lui-même les références des autres
--    tables, `legacy_alter_table` étant à OFF. Une base antérieure reste lisible.

ALTER TABLE meetings RENAME TO live_sessions;
ALTER TABLE meeting_participants RENAME TO live_session_participants;
ALTER TABLE live_session_participants RENAME COLUMN meeting_id TO live_session_id;

-- ⚠️ Les index ne suivent pas le nom de leur table : SQLite les garde tels quels après un
-- `RENAME TO`. Ils resteraient nommés `idx_meetings_*` sur une table `live_sessions`, ce qui ne
-- casse rien mais rend le schéma menteur au premier qui le lira.
DROP INDEX idx_meetings_started_at;
DROP INDEX idx_meeting_participants_meeting_id;
DROP INDEX idx_meeting_participants_voice_id;

CREATE INDEX idx_live_sessions_started_at ON live_sessions (started_at DESC);
CREATE INDEX idx_live_session_participants_live_session_id ON live_session_participants (live_session_id);
CREATE INDEX idx_live_session_participants_voice_id ON live_session_participants (voice_id);

-- L'usage du prompt personnalisé est une valeur, pas un nom d'objet : il se met à jour.
-- ⚠️ Le prompt lui-même n'est pas touché : c'est du contenu utilisateur.
UPDATE user_prompts SET usage = 'live_report' WHERE usage = 'meeting_report';
