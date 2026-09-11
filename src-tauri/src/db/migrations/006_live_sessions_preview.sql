-- Un aperçu du transcript, pour que le panneau d'historique n'ait pas à le lire.
--
-- Le panneau montre deux lignes par session, un titre et une méta. Sans cette colonne, remplir
-- la liste obligeait à lire, déchiffrer et désérialiser le `transcript` de chaque session —
-- quelques centaines de kilo-octets par heure enregistrée — pour n'en afficher aucun caractère.
--
-- Pièges
--
-- ⚠️ Donnée dérivée et figée : elle s'écrit une fois, à l'archivage, et rien ne la met à jour.
--    Un renommage touche `title`, un compte rendu touche `report`.
-- ⚠️ Les sessions déjà archivées gardent un aperçu vide et rien ne le rattrape. Elles se
--    listent, s'ouvrent et s'exportent normalement ; seule la recherche par contenu ne les
--    trouve pas, et elles restent trouvables par leur titre.
-- ⚠️ Ce n'est pas une recherche plein texte : l'aperçu est le début de la session. Chercher un
--    mot prononcé à la quarantième minute ne rend rien.

ALTER TABLE live_sessions ADD COLUMN preview TEXT NOT NULL DEFAULT '';
