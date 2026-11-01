# Installation du journal de reprise DATAtourisme — arrêt contrôlé

## Verdict

**PILOTE RÉEL DE 75 OCCURRENCES PRÊT À ÊTRE AUTORISÉ : NON**

La migration de journal est appliquée et ses objets sont vérifiés. La configuration du compte de connexion est créée, mais sa vérification native PostgreSQL échoue pendant TLS : `self-signed certificate in certificate chain`. Conformément à la consigne d’arrêt lors d’une anomalie d’installation, aucune préparation ultérieure du snapshot ou du pilote n’a été effectuée. La validation du certificat n’a pas été désactivée. Le diagnostic établit un échec de chaîne de confiance côté client ; il ne permet pas, à lui seul, d’attribuer l’origine au serveur, au certificat racine manquant ou à un intermédiaire réseau.

## Audit et corrections de la migration

Fichier appliqué : `migrations/2026-10-29-sortir-organizer-recovery-journal.sql`.
SHA-256 : `4bea69896d130353bb4af6dc745514481d4dc7624b1b9e01dddd489d9a28e7ff`.
Application confirmée le 29 octobre 2026 à 02:40:54 UTC.

- Transaction unique ; délais de verrou et d’instruction ; verrous NOWAIT ; refus si ingestion active. Une erreur annule objets, rôle et politiques de cette transaction.
- Refus d’un rôle préexistant pour éviter de réutiliser des privilèges inconnus.
- Une table de journal avec trois contraintes de format/type, contrainte de numéro de lot positif ou nul et clé primaire `(plan_hash, batch_number)` ; un index, celui de la clé primaire. Aucun objet métier créé ou supprimé.
- Une fonction SECURITY DEFINER propriétaire postgres, search_path fixe et sans écriture métier. Elle verrouille les tables, vérifie le verrou scheduler et les ingestions, puis retourne les compteurs de visibilité pour détecter une lecture incomplète sous RLS.
- Rôle writer NOLOGIN, NOINHERIT, sans superuser, BYPASSRLS, création de rôle/base ou réplication. SELECT sur les neuf tables concernées ; UPDATE limité aux colonnes `record_status`, `updated_at` ; SELECT/INSERT du journal ; EXECUTE de la seule fonction dédiée.
- Douze politiques RLS vérifiées : neuf SELECT métier, une UPDATE activité, deux journal. Garde UPDATE limitée aux REVIEW avec provenance DATAtourisme active, sans provenance active d’un autre connecteur, avec diagnostic historique concerné, hors quarantaine. Les autres conditions métier et comparaisons DISTINCT restent revalidées par le writer.
- Aucun accès journal ou fonction pour anon/authenticated/service_role, ni appartenance au rôle writer pour ces rôles. Cela n’enlève pas les droits administratifs du propriétaire postgres.
- Le script `migrations/2026-10-29-sortir-organizer-recovery-disable.sql`, testé localement et NON appliqué en production, retire les droits d’exécution et de promotion et désactive le compte de connexion. Il conserve le journal et toutes les données métier ; aucune rétrogradation automatique et aucune perte d’historique.

Le schéma existant est compatible. Aucun changement de règles métier DATAtourisme, aucune migration supplémentaire appliquée.

## Compte dédié et anomalie d’installation

Le rôle de connexion `sortir_organizer_recovery_login` est LOGIN, NOINHERIT, sans aucun des privilèges administratifs précités, limité à deux connexions. Son appartenance au writer permet SET ROLE, sans héritage ni ADMIN OPTION. Mot de passe aléatoire enregistré uniquement dans le trousseau macOS ; aucun secret dans les fichiers projet. La connexion de contrôle était BEGIN READ ONLY puis SET LOCAL ROLE ; TLS échoue avant toute requête SQL sur cette connexion. L’accès n’est donc pas certifié utilisable et la configuration n’est pas déclarée opérationnelle.

La configuration SQL du rôle a été commitée avant l’échec de connexion ; elle existe encore. Aucune révocation ou nouvelle modification en production après l’anomalie. Les contrôles finaux ont utilisé l’accès de gestion existant en lecture seule.

## Compteurs mesurés

Contrôle final : **2026-10-29 12:54:28 UTC**, soit 16:54:28 à La Réunion.

| Objet | Avant migration | Après / contrôle final |
|---|---:|---:|
| Activités | 79 571 | 79 571 |
| Provenances | 80 287 | 80 287 |
| External IDs | 240 283 | 240 283 |
| Collection items / historique | 89 691 | 89 691 |
| Décisions de déduplication | 715 | 715 |
| Journal de reprise | absent | 0 lot |

État final des activités, tous horizons et connecteurs confondus : **38 342 active**, **39 490 review**. Ce dernier compteur n’est pas le nombre national des REVIEW DATAtourisme futures avec diagnostic : ces périmètres ne sont pas interchangeables. Aucune nouvelle estimation des occurrences libérables n’a été réalisée.

**0 ingestion en cours, 0 source run en cours, 0 lot historique exécuté, aucune promotion par cette intervention.** Aucun lancement d’ingestion, scheduler ou writer réel.

## Scheduler

Le verrou `sortir-scheduler-lock-v1` attendu est absent avant et après installation : zéro ligne. Le writer refuse alors toute reprise. Derniers logs consultés : action GitHub du 28 octobre à 23:24 UTC, réponses HTTP 200 et `not due` ; aucune exécution observée dans la fenêtre quotidienne du 29 octobre 00:00–00:40 UTC lors de cette inspection. Il s’agit d’un constat préexistant à la migration ; aucune causalité avec celle-ci n’est établie. L’état courant final confirme l’absence du verrou, mais aucun nouveau tick n’a été déclenché pour tester le scheduler. Son bon fonctionnement quotidien ne peut pas être certifié.

## Tests

Après durcissement de la migration : **5 tests migration réussis**, puis **22 tests PostgreSQL natifs réussis**, zéro échec et zéro test ignoré dans cette exécution native. Sont couverts notamment rollback intégral du DDL, collision de rôle, ingestion concurrente, RLS, privilèges interdits et désactivation avec conservation du journal.

Les 732 tests Sortir/scheduler et l’échec Explorer préexistant sont les résultats de la validation précédente ; ils ne sont pas présentés comme une nouvelle exécution après installation. L’arrêt sur anomalie TLS a interrompu la suite de validation demandée.

## Snapshot, pilote et risques résiduels

Aucun ancien snapshot /tmp réutilisé. Aucun nouveau snapshot complet, aucune répartition nationale ou communale recalculée, aucun plan de 75 scellé, aucun dry-run pilote réalisé dans cette installation interrompue. Les nombres historiques de 35 269, 630 et 646 restent des références anciennes, pas des mesures actuelles.

Deux obstacles demeurent : établir la chaîne TLS de confiance pour l’accès dédié sans affaiblir la validation, puis résoudre/vérifier le fonctionnement du scheduler et la présence de son verrou sans forcer une ingestion dans cette étape. Après cela seulement : nouveau snapshot, sélection et scellement du lot, dry-run, validation finale. Aucun pilote ne doit être autorisé sur la base du présent état.

## Fichiers et état Git

Corrections de cette intervention : migration de journal durcie ; nouveau script de désactivation ; test `sortir/test-organizer-recovery-migration.js` ; adaptation du helper de fixtures pour isoler les rôles locaux entre tests ; exclusion `sortir/recovery-data/` dans `.gitignore` ; présent rapport.

Les fichiers du writer et leurs modifications préexistaient à cette intervention et restent non commités. Les preuves sans secrets sont conservées dans `sortir/recovery-data/2026-10-29-installation/`, exclu de Git. L’état Git détaillé est conservé dans `git-status.txt` à côté des preuves. Aucun commit, aucun push.
