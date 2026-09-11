-- Les locuteurs sortent du produit : le répertoire de voix et les participants disparaissent.
--
-- `voices.embedding` portait une empreinte vocale, la seule donnée biométrique de
-- l'application. Aucune ligne n'y a jamais été écrite : la table est retirée plutôt que gardée
-- vide, une table vide portant ce nom étant une invitation à l'y remplir.
--
-- Pièges
--
-- ⚠️ Le jour où une empreinte serait écrite, tout redevient obligatoire : opt-in désactivé par
--    défaut, chiffrement, suppression réelle, revue juridique. Voir `docs/v2/locuteurs.md`.
-- ⚠️ Le filtre d'écho du Direct calcule encore des empreintes ; elles meurent avec la session
--    et ne touchent jamais le disque. C'est ce que cette migration rend vrai sans exception.
-- ⚠️ L'ordre compte : la table qui référence part avant la table référencée, sinon la clé
--    étrangère refuse la suppression — `PRAGMA foreign_keys` est actif à chaque ouverture.

DROP TABLE live_session_participants;
DROP TABLE voices;
