# Verrou partagé Sortir / reprise historique — installation en production

## Résultat

**VERROU PRODUCTION OPÉRATIONNEL : OUI**

**SCHEDULER QUOTIDIEN FIABLE : À CONFIRMER**

Autorisation utilisateur limitée à l’initialisation du verrou et à ses contrôles. Script exact appliqué : sortir/organizer-recovery-scheduler-bootstrap.sql, SHA-256 **b2c9d0dabb08c8a3ac94ff76aa0195e1aa657c5f2dcc5e92f5b1cd851a0e0ed0**. Aucune modification du script, du code métier, des permissions, du scheduler ou des migrations pendant cette intervention.

La seule mutation durable est l’insertion de la ligne technique d’exclusion. Les tentatives d’acquisition utilisées pour les contrôles sont annulées par transaction ; elles ne démarrent aucun pipeline.

## Préconditions et installation

État avant mesuré à **2026-10-29 13:28:35.387818+00** : zéro ingestion running, zéro source run running, ligne technique absente et journal historique vide. Permission de lecture et EXECUTE de la fonction vérifiées avec le compte dédié et TLS complet. Le writer ne possède pas UPDATE sur le journal des ingestions ; il conserve seulement UPDATE(record_status,updated_at) sur les activités. Aucun rôle privilégié, héritage ou BYPASSRLS ajouté au compte dédié. Le script revérifie l’absence d’ingestion sous verrous NOWAIT et refuse une ligne préexistante incohérente.

Ligne créée en base à **2026-10-29T13:31:00.404818+00:00**, soit 17:31 le 29 octobre à La Réunion :
- id : be127190-19a4-4f50-b615-7a9a78b8ff14 ;
- version : sortir-scheduler-lock-v1 ;
- status : completed, c’est-à-dire mutex technique disponible ;
- compteurs métier de cette ligne : tous zéro ; error_summary vide.

Ce statut technique ne certifie aucune ingestion quotidienne réussie. Le nombre de lignes sortir_ingestion_runs passe de **808 à 809** uniquement pour ce mutex.

## Contrôles réels en production

1. **Fonction du writer** : acquisition réussie sous sortir_organizer_recovery_writer. Le catalogue pg_locks confirme dix verrous SHARE ROW EXCLUSIVE accordés sur activities, provenances, external IDs, collection items, décisions, sources, ingestion runs, source runs, états POI et journal de reprise. TLS vérifié pour toutes les connexions natives.
2. **Deux instances** : processus A détenteur, connexion indépendante B. L’acquisition de B est refusée immédiatement avec **SQLSTATE 55P03** ; B effectue ROLLBACK. Aucune double acquisition.
3. **Scheduler contre writer** : sous le rôle réel service_role, tentative conditionnelle completed→running de la seule ligne technique, avec délai de verrou de 500 ms. Pendant la détention de A : **55P03**, donc écriture exclue. Après libération : acquisition SQL possible. Dans les deux cas, la sous-transaction et la transaction sont annulées ; aucun status=running n’est commité et aucune ingestion n’est appelée. Le JSON complet de la ligne technique est identique avant et après ces sondes.
4. **Interruption brutale** : le processus détenteur A a été arrêté par **SIGKILL**, sans COMMIT ni libération applicative. La connexion B a repris les verrous à sa première tentative, en **1005 ms**. Les verrous transactionnels ont donc été libérés après fermeture de la session interrompue. Aucun journal ou activité écrit.
5. **État final** : mutex disponible completed, aucune ingestion/source running, journal historique toujours vide. Aucun verrou de test conservé ; transactions de contrôle annulées et connexions fermées.

Le scheduler utilise INSERT/clé primaire puis CAS sur cette même ligne ; le writer utilise la fonction de verrouillage et contrôle l’état de cette ligne. Ces primitives diffèrent, mais les écritures du scheduler prennent un verrou de table incompatible avec celui du writer. L’exclusion repose sur le même PostgreSQL et a été mesurée en production, sans changement de ce mécanisme.

Le chemin complet du scheduler a déjà été testé hors production lors de l’étape précédente. Ici, seuls l’acquisition SQL et son blocage sont testés : aucune exécution du pipeline d’ingestion.

## Données et privilèges avant/après

Contrôle final : **2026-10-29 13:32:35.43756+00**. Empreintes calculées sur toutes les colonnes de toutes les lignes, avec ordre déterministe :

| Objet | Avant | Après | Empreinte complète identique |
|---|---:|---:|---|
| Activités | 79 571 | 79 571 | Oui |
| Provenances | 80 287 | 80 287 | Oui |
| External IDs | 240 283 | 240 283 | Oui |
| Source runs | 839 | 839 | Sans nouveau run |
| Lots du journal historique | 0 | 0 | Aucun lot exécuté |

Statuts identiques : **38 342 active, 39 490 review, 1 735 stale, 4 merged**. Les empreintes complètes incluent les dates, champs métier, identités et payloads des provenances : aucune différence de contenu détectée, au-delà de la seule égalité des compteurs.

Empreintes agrégées MD5 de contrôle, identiques avant/après :
- activités : ab4feaf546cabe1b997192c2c68d26e7 ;
- provenances : 2c9d184923a3aaf497d7bef73753d716 ;
- external IDs : f2b09fa98aa10c0e283bc9006d4b0c7e.

ACL des tables, politiques RLS, attributs des rôles, privilèges par colonne et définition de la fonction : tous identiques avant/après. Aucun GRANT, REVOKE, CREATE ROLE ou ALTER ROLE exécuté. Les preuves contiennent les assertions détaillées dans final-validation.json.

## Déclenchement quotidien à 04:00 Réunion

Configuration locale auditée : heure Sortir **04:00**, fuseau du serveur **Indian/Reunion**, UTC+4 ; fenêtre exacte **04:00 <= heure locale < 04:40**, soit **00:00 <= UTC < 00:40**. Le workflow GitHub auto-collect.yml est active et programme un tick toutes les cinq minutes. Aucun réglage modifié.

Dernier journal disponible consulté : run **40845079273**, 29 octobre 2026 **08:50:40 UTC** (12:50 Réunion), conclusion success. Le endpoint Sortir répond HTTP 200 avec triggered=false, reason=not due. Cette réponse confirme un tick traité, pas une ingestion exécutée. Elle suit la branche où les pipelines automatiques sont activés, car le serveur renverrait sinon auto pipelines disabled on this instance.

Dans les 50 runs consultés, aucun passage dans la fenêtre du 29 octobre 00:00–00:40 UTC. L’initialisation du mutex corrige le prérequis d’exclusion ; elle ne répare ni ne prouve la ponctualité du déclencheur GitHub. La raison interne des ticks omis ou retardés côté GitHub n’est pas établie par ces journaux. L’horaire est correct dans le code audité ; aucun contrôle artificiel du tick ni preuve nouvelle d’un cycle quotidien complet en production n’a été fabriqué.

D’où le verdict **À CONFIRMER** pour la fiabilité quotidienne. Une observation d’un prochain cycle naturel, avec runs enveloppes et sources completed, reste nécessaire. Aucune automation de surveillance n’a été créée.

## Risques résiduels et limites

- La récupération automatique mesurée concerne une transaction writer interrompue, dont les verrous sont transactionnels. Si le scheduler meurt après avoir COMMITÉ sa réservation technique running, cette ligne n’expire pas automatiquement : un contrôle opérateur est nécessaire avant toute remise à disposition. Ce comportement de sécurité préexistant évite de reprendre le verrou d’un processus encore vivant ; il n’a pas été modifié ni testé en produisant une réservation durable running.
- Les verrous du writer bloquent temporairement les écritures Sortir pendant un lot ; les contrôles ont été brefs et sans ingestion active. La durée et les timeouts d’un futur lot réel restent à surveiller lors d’une autorisation distincte.
- Le déclenchement quotidien n’a toujours pas de preuve de régularité dans les journaux disponibles.
- Le pilote scellé n’a pas été exécuté, ni recalculé dans cette étape limitée au verrou. Toute autorisation ultérieure doit revalider empreintes, dates et absence d’ingestion ; une ingestion naturelle peut rendre le plan antérieur obsolète.

## Preuves et Git

Preuves durables, sans secrets : sortir/recovery-data/2026-10-29-lock-production/ (exclu de Git). Fichiers principaux : before.json, installation.json, installed-lock.json, concurrent-writers.json, scheduler-blocked.json, scheduler-after-release.json, interruption-recovery.json, actual-postgres-locks.json, after.json, final-validation.json et scheduler-evidence.json. Scripts de contrôle conservés pour traçabilité ; aucun mot de passe ni jeton enregistré.

Seul nouveau fichier documentaire suivi potentiel de cette intervention : sortir/organizer-recovery-lock-production-report.md. Les modifications de code et fichiers non suivis précédents sont conservés. État détaillé dans git-status.txt. Aucun commit ni push.

**VERROU PRODUCTION OPÉRATIONNEL : OUI**

**SCHEDULER QUOTIDIEN FIABLE : À CONFIRMER**
