-- Les prompts écrits par l'utilisateur, une ligne par usage.
--
-- Une table à clé plutôt qu'une colonne par usage : ajouter une ligne ne coûte pas une
-- migration, ajouter une colonne si.
--
-- Pièges
--
-- ⚠️ Ces prompts vont en base et non dans le fichier de réglages, qui est un JSON en clair.
--    C'est du texte libre écrit par l'utilisateur : il y nomme un métier, un employeur, un
--    client. Rien de sensible n'entre dans les réglages.
-- ⚠️ `usage` n'est jamais un argument d'une commande IPC : aucune commande n'expose de SQL
--    générique. Chaque usage a sa paire de commandes, avec son nom en dur côté Rust.
CREATE TABLE user_prompts (
  usage      TEXT PRIMARY KEY,
  prompt     TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
