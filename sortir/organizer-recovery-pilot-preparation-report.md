# Préparation du pilote historique organizer_name_missing — 29 octobre 2026

## Verdict et périmètre

**PILOTE RÉEL DE 75 OCCURRENCES PRÊT À ÊTRE AUTORISÉ : NON**

TLS est corrigé et vérifié. Le lot de 75 est recalculé, scellé et revalidé en lecture seule sur l’état réel. Le garde-fou d’exécution reste volontairement fermé : la ligne technique du scheduler est toujours absente. Le script minimal pour l’initialiser est préparé et testé, mais son application en production requiert une autorisation distincte. La régularité du déclenchement quotidien n’est pas démontrée.

Pendant cette intervention : **aucune écriture SQL en production**, aucun lancement du writer, aucune promotion, ingestion, migration, exécution forcée du scheduler, désactivation du scheduler, commit ou push. Toutes les écritures des tests ont eu lieu sur des bases isolées.

## 1. TLS : cause et correction

Hôte réellement utilisé : **aws-1-eu-west-1.pooler.supabase.com:5432**, pooler Supabase en mode session. Compte de connexion : sortir_organizer_recovery_login ; rôle SQL de lecture contrôlée : sortir_organizer_recovery_writer.

La chaîne présentée comporte la feuille *.pooler.supabase.com (12 mars 2025–11 mars 2030), l’intermédiaire Supabase Intermediate 2021 CA (24 octobre 2023–21 octobre 2033) et Supabase Root 2021 CA (28 avril 2021–26 avril 2031). Les intermédiaires sont présents. La racine privée Supabase n’est pas une racine publique reconnue par le magasin utilisé ici par Node.js v22.18.0 / OpenSSL 3.0.16, sans NODE_EXTRA_CA_CERTS. L’ancienne connexion pg 8.23.1 demandait rejectUnauthorized=true sans fournir cette racine : erreur de chaîne de confiance 19. Les paramètres du compte n’étaient pas la cause : le même secret fonctionne après correction TLS.

L’URL de distribution exacte a été retrouvée dans la configuration officielle du tableau de bord :
https://github.com/supabase/supabase/blob/master/apps/studio/hooks/custom-content/custom-content.json

CA téléchargée via HTTPS vérifié :
https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt

Empreinte SHA-256 de la racine : **80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA**. Elle correspond à la racine présentée ; sa confiance provient du téléchargement officiel authentifié, pas de la connexion initialement rejetée.

Le nouveau module sortir/organizer-recovery-connection.js fournit explicitement la CA, rejectUnauthorized=true, TLS >=1.2 et le contrôle standard du nom d’hôte. Il exige SORTIR_RECOVERY_CA_FILE, les identifiants explicites du compte dédié et la base ; il refuse les paramètres URL pouvant écraser les options TLS ou l’hôte, un compte administratif et la désactivation globale de validation. Le CLI writer utilise ce module ; son empreinte fait partie du codeHash des plans. Aucun fichier .env ni secret du trousseau n’a été modifié ou exporté dans le projet.

Preuve à 2026-10-29T13:02:15.962Z : tlsAuthorized=true, authorizationError=null, **TLSv1.3**, chiffrement **TLS_AES_256_GCM_SHA384** ; session_user=sortir_organizer_recovery_login, current_user=sortir_organizer_recovery_writer et transaction_read_only=on. Requête strictement en lecture seule : journal=0. OpenSSL avec contrôle du nom et de la CA retourne également Verify return code: 0 (ok).

Cette preuve porte sur la liaison client → pooler réellement utilisée. Elle ne constitue pas un audit de l’implémentation TLS interne du fournisseur entre pooler et serveur PostgreSQL.

## 2. État du scheduler et exclusion

Le workflow GitHub auto-collect.yml est **active** et configuré toutes les cinq minutes. Dernier passage consulté : **40845079273, 29 octobre 2026 08:50:40 UTC**, terminé success sur HEAD 3539d309fe660a7aab4f8696e77fe46ca5f0fb81. La réponse Sortir est HTTP 200, triggered=false, reason=not due. Aucun run listé dans la fenêtre du 29 octobre **00:00 <= UTC < 00:40**, correspondant à 04:00–04:40 Réunion. Les raisons du retard ou de l’omission côté GitHub ne sont pas établies par ces logs ; le constat exact est l’absence de tick dans la fenêtre.

Dans sortir-auto-ingest.js, la sortie not due précède createSchedulerState/acquire. Le verrou n’est donc jamais initialisé par ces ticks. La base contient zéro ligne de version sortir-scheduler-lock-v1 et aucun run enveloppe scheduler observé lors des vérifications. On peut certifier un déclencheur configuré actif et un dernier tick réussi ; **on ne peut pas certifier une ingestion quotidienne réussie**. Ce défaut précède la migration de reprise.

Les primitives ne sont pas identiques : le scheduler fait INSERT sur la clé technique puis CAS completed→running ; le writer prend des verrous PostgreSQL SHARE ROW EXCLUSIVE sur dix tables et vérifie cette même clé/version ainsi que l’absence de runs actifs. Les INSERT/UPDATE du scheduler nécessitent des verrous incompatibles sur sortir_ingestion_runs. Ils partagent ainsi le même domaine d’exclusion PostgreSQL ; il ne s’agit pas de deux mutex indépendants.

Le writer conserve son refus si la ligne est absente, active ou incohérente. Aucun contournement n’a été ajouté.

Correction minimale préparée : **sortir/organizer-recovery-scheduler-bootstrap.sql**, NON APPLIQUÉ. Transaction atomique, verrous NOWAIT, refus de toute ingestion active ou verrou incohérent ; insertion idempotente de la seule ligne technique completed, sans remplacer une ligne existante ni inventer un run métier. Les colonnes, valeurs par défaut et contraintes ont été comparées au schéma réel. Le script ne déclenche pas le scheduler et ne modifie pas ses horaires. Il ne résout pas les créneaux manqués par GitHub ; la fiabilité du déclencheur nécessite une décision opérationnelle distincte.

## 3. Permissions et RLS

Vérification actuelle via catalogues en lecture seule : rôle login NOINHERIT, sans superuser, BYPASSRLS, CREATEROLE, CREATEDB ou réplication ; deux connexions maximum. Appartenance au writer avec SET=true, INHERIT=false, ADMIN=false. Aucun droit direct sur les tables publiques pour le login, ni CREATE sur public pour les deux rôles.

Le writer dispose du SELECT sur neuf tables métier et sur le journal, INSERT journal et UPDATE de record_status/updated_at uniquement. Aucun INSERT/DELETE/TRUNCATE métier ni UPDATE des intervalles ou identités. Douze politiques RLS dédiées sont présentes ; anon/authenticated/service_role n’ont ni accès au journal ni EXECUTE de la fonction de verrouillage. Le propriétaire administratif postgres conserve ses droits de maintenance.

La fonction SECURITY DEFINER préexistante reject_anonymous_learning_social_event(), accessible via PUBLIC, retourne trigger ; elle ne peut pas être invoquée comme une fonction SQL ordinaire et ne donne aucun accès d’écriture Sortir. Aucune nouvelle fonction privilégiée inattendue détectée.

La RLS est une défense partielle de périmètre (diagnostic, connecteur, statut, quarantaine) ; l’ensemble des règles de validation et DISTINCT est recontrôlé par le writer. Aucune règle métier DATAtourisme modifiée.

## 4. Tests hors production

- **47 suites Sortir/scheduler : 749 cas réussis**, zéro suite en échec. Fetch externe interdit pendant ces suites.
- **25 tests PostgreSQL natifs : 25 réussis, zéro échec, zéro ignoré**, base loopback dédiée.
- Dans ces validations : **12 tests TLS**, dont handshake local valide, rejet d’un mauvais nom, rejet d’une CA inconnue, refus des paramètres affaiblissant la connexion et d’un compte privilégié.
- **5 tests migration** : collision de rôle, rollback DDL, ingestion active, protections RLS et désactivation conservant l’historique.

Les chiffres TLS/migration font partie des suites générales, ils ne sont pas additionnés artificiellement aux 749 cas. Les 25 tests natifs sont une exécution supplémentaire.

Tests de concurrence utilisant le vrai createSchedulerState via un adaptateur SQL local : création initiale quand la ligne manque, acquisition atomique, seconde acquisition refusée, writer refusé pendant le scheduler, tentative INSERT/CAS bloquée par les verrous du writer, acquisition à nouveau possible après COMMIT. Sont également couverts ingestion manuelle concurrente, rollback, interruption, reprise, idempotence, privilèges et visibilité RLS incomplète. Le bootstrap est idempotent et refuse un run actif sans modifier les identités.

Aucun fichier Explorer modifié. L’échec préexistant de l’ordre des cartes Explorer documenté précédemment n’a pas été présenté comme corrigé ou rejoué dans cette intervention.

## 5. Nouveau snapshot et compteurs

Répertoire durable : **sortir/recovery-data/2026-10-29-pilot-preparation/snapshot/**. Capture entièrement nouvelle, transaction unique REPEATABLE READ READ ONLY, rôle dédié, TLS vérifié, SHA-256 par fichier. Instant logique : **2026-10-29 13:03:25.806 UTC** (17:03:25.806 Réunion). Aucun ancien snapshot /tmp utilisé. Paramètres de sources sensibles et payloads bruts exclus ; seules les métadonnées publiques et périodes nécessaires sont exportées.

| Table / état | Référence avant | Snapshot | Contrôle final |
|---|---:|---:|---:|
| Activités | 79 571 | 79 571 | 79 571 |
| Provenances | 80 287 | 80 287 | 80 287 |
| External IDs | 240 283 | 240 283 | 240 283 |
| Collection items | 89 691 | 89 691 | 89 691 |
| Décisions | 715 | 715 | 715 |
| Journal de reprise | 0 | 0 | 0 |

Snapshot : 808 ingestion runs, 839 source runs, 62 742 états POI et 13 sources. Dernier contrôle : **2026-10-29 13:15:25.354894+00** ; active=38 342, review=39 490 tous horizons, zéro ingestion/source run actif et zéro ligne du verrou attendu.

### Recalcul actuel — mesures, pas attentes

- REVIEW futures/en cours tous connecteurs : **35 810**.
- Dont DATAtourisme : **35 503**.
- DATAtourisme avec diagnostic cible : **35 175**.
- Potentiellement libérables : **34 567**.
- À conserver en REVIEW parmi les ciblées : **608 = 356 quarantaines + 243 ambiguïtés moteur + 9 autres validations**.
- Autres REVIEW DATAtourisme futures non concernées : **328**.
- Autres connecteurs : **307 = 305 OpenAgenda + 2 Paris Data**.
- Autres REVIEW tous connecteurs sans diagnostic cible : **635 = 328 + 307**.

Recalcul complet : **7 781 703 comparaisons**, zéro erreur, aucun nouveau MATCH autorisé, aucune écriture. Principales communes promouvables : Toulouse (553), Limoges (493), Metz (405), Angers (402), Aix-en-Provence (329), Le Havre (324), Le Mans (299), Montpellier (262), Nancy (232), Marseille 2e Arrondissement (230). Détail par source et communes dans review-snapshot-summary.json et national-summary.json.

### Écart avec l’audit précédent

Ancienne référence : 35 269 libérables, 630 retenues, 646 autres REVIEW ; instant 2026-10-28 17:38:11.011 UTC.

Une simulation supplémentaire, toujours sur le nouveau snapshot, a isolé exactement les dossiers sortis de l’horizon temporel : **724 ciblées = 702 anciennement libérables + 22 anciennement retenues**, et **11 autres REVIEW**. Les 22 retenues expirées sont 12 quarantaines et 10 ambiguïtés. On retrouve sur les données fraîches, à l’ancien horizon, exactement 35 899 ciblées et 36 545 REVIEW totales. Les écarts de compteurs d’éligibilité sont ainsi expliqués par le temps écoulé ; aucune promotion n’a été faite pour les obtenir.

## 6. Pilote scellé de 75

Plan : **sortir/recovery-data/2026-10-29-pilot-preparation/pilot-sealed-plan.json**.

PlanHash : **b866b229d2079a0c70bbd6799ffeb61e4ff726542fcd609cda084cc3abd84118**.
CodeHash : **7c78467c1410148dc831305f7a9c879eaaff06bdbe493f95ac38a9623c5421e4**.
SnapshotKey : **48bf0ffb4fc8ae98545d410f43bc06b4cbdfb877cb4f6839ddc94278a6295ab0**.

Sélection : **Toulouse : 8 ; Strasbourg : 8 ; Limoges : 8 ; Metz : 8 ; Angers : 8 ; Le Mans : 8 ; Le Havre : 8 ; Marseille : 7 ; Montpellier : 6 ; Aix-en-Provence : 6**. 35 cas simples ; 40 occurrences appartenant à des séries, dont dix groupes comprenant plusieurs séances sélectionnées. Tous sont DISTINCT DATAtourisme, sans autre diagnostic bloquant, ambiguïté ou quarantaine. Sélection effectuée parmi des décisions déjà calculées sur l’index national complet, puis vérifiée comme sous-ensemble PROMOTE du recalcul national terminé.

Dry-run complet : **75 examinées, 75 PROMOTE, 0 REVIEW, 0 quarantaine, 0 ambiguïté, 0 erreur, 0 écriture**. BatchSize=75 et exactement un lot scellé.

Relecture réelle à **2026-10-29T13:14:18.305Z**, TLS vérifié et transaction READ ONLY : **75/75 empreintes conformes**, éligibilité favorable après **20 396 comparaisons sur 16 506 candidats**. Relations mesurées : **75 provenances et 225 external IDs**. Projection simulée : seul record_status change ; aucune modification d’identité, regroupement ou intervalle. Ce résultat ne remplace pas une transaction réelle, volontairement interdite.

Les séries restent des occurrences séparées. Exemple Strasbourg : même POI, trois intervalles conservés (départs 12 novembre 09:00 UTC vers 24 décembre 12:00 UTC, 12 novembre 09:00 vers 24 décembre 17:00 et 12 novembre 13:00 vers 24 décembre 17:00). Ces intervalles source sont préservés tels quels, sans interprétation ou correction de leurs durées. Les autres séances multiples, notamment Metz et Le Mans, conservent aussi chacune leur identité et leur intervalle. Inventaire complet dans pilot-selection.json.

**Éligibilité des données : validée. Prérequis d’exécution : non satisfaits** (completed_scheduler_locks=0). Le plan n’est pas une autorisation. Aucun ancien plan réutilisé ; la correction TLS change le codeHash et rend les anciens plans incompatibles. Toute modification future du code ou des données impose revalidation/recalcul des décisions concernées ; après une ingestion, un changement de fingerprint fera refuser le lot.

## 7. Fichiers et Git

Changements de cette étape :
- sortir/organizer-recovery-connection.js : configuration TLS stricte.
- sortir/run-organizer-review-writer.js : utilisation de cette connexion.
- sortir/organizer-review-writer.js : inclusion du module TLS dans l’empreinte du code.
- sortir/test-organizer-recovery-connection.js : tests TLS positifs et négatifs.
- sortir/test-helpers/scheduler-postgres-client.js : adaptateur isolé pour tester le code réel du scheduler.
- sortir/test-organizer-review-writer.js : trois cas natifs supplémentaires (scheduler réel et bootstrap).
- sortir/organizer-recovery-scheduler-bootstrap.sql : correction technique préparée, NON appliquée.
- sortir/organizer-recovery-pilot-preparation-report.md : présent rapport.

Les fichiers de la précédente implémentation et de l’installation restent également non commités. État Git détaillé : git-status.txt dans les preuves. Les données de reprise restent exclues de Git par .gitignore. Aucun commit ni push.

## 8. Suite restant à autoriser

1. Initialiser la seule ligne technique du verrou avec le script préparé, après contrôle d’absence de runs actifs ; aucune ingestion nécessaire pour cette opération.
2. Vérifier ensuite la ligne/version, les droits et la revalidation du plan en lecture seule.
3. Traiter séparément la fiabilité du déclenchement quotidien : les logs actuels ne prouvent aucun cycle exécuté dans sa fenêtre.

Le writer réel et toute promotion restent interdits dans l’état présent.

**PILOTE RÉEL DE 75 OCCURRENCES PRÊT À ÊTRE AUTORISÉ : NON**
