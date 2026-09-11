-- Les prompts de compte rendu écrits par l'utilisateur, une ligne par prompt NOMMÉ.
--
-- `user_prompts` sert la reformulation de dictée, une ligne par usage. Le compte rendu, lui, en
-- veut plusieurs — un par client, un par type de note — là où un prompt unique s'écrasait.
--
-- Pièges
--
-- ⚠️ AUTOINCREMENT, et non le rowid nu : SQLite RÉATTRIBUE un rowid libéré. Un prompt supprimé
--    rendrait son numéro au suivant, et le réglage qui retient le prompt par défaut désignerait
--    silencieusement un autre prompt que celui qu'on avait choisi.
-- ⚠️ Le TITRE est du contenu utilisateur autant que le prompt : « Bilan Dupont & Fils » nomme un
--    client. Il reste dans la base chiffrée — jamais dans le fichier de réglages, qui est un JSON
--    en clair, jamais dans un message de log.
-- ⚠️ L'unicité des titres est SANS CASSE : deux entrées indistinguables à l'œil dans un menu
--    déroulant rendraient le choix du prompt par défaut incompréhensible.
CREATE TABLE report_prompts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  prompt     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX report_prompts_title ON report_prompts (title COLLATE NOCASE);
