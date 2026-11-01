# Décision préalable au pilote historique de 75 occurrences

## Verdict

**C — INVESTIGATION NÉCESSAIRE**

Les protections TLS, permissions, concurrence, transactions et checkpoints sont opérationnelles. Le nouveau dry-run confirme les 75 décisions DISTINCT et les empreintes du plan scellé. Cependant, un contrôle complémentaire du zonage Explorer rejette **4 dossiers de Marseille avec postal_code=13055**. La cause source/géographie/référentiel de ce rejet n’est pas établie dans cette intervention. La validation est donc arrêtée sans modification du lot ni des données, conformément à la consigne d’arrêt sur anomalie inexpliquée.

Ce verdict n’est pas motivé par les ticks quotidiens manquants : ce défaut est indépendant de la protection transactionnelle du pilote. Il concerne la preuve encore manquante de publication géographique correcte des quatre dossiers.

Aucune promotion, aucun appel au writer d’écriture, aucun lot historique, aucune ingestion, aucun changement du scheduler, aucune migration, aucun commit ni push. Toutes les connexions SQL de cette intervention sont en lecture seule ; aucune fonction de prise de verrou n’a été exécutée ici.

## 1. État actuel et prérequis

Lecture des compteurs et empreintes à **2026-10-29 13:44:46.014269+00**. Revalidation des 75 à **2026-10-29T13:48:01.143Z**, soit 17:48:01 à La Réunion. Dernier contrôle opérationnel : **2026-10-29 13:51:07.457608+00**.

- Connexion native PostgreSQL avec CA officielle, vérification du nom d’hôte et rejectUnauthorized=true : **tlsAuthorized=true**. Transaction REPEATABLE READ READ ONLY ; SET LOCAL ROLE vers le rôle dédié. Aucun secret du trousseau exporté.
- Ligne technique be127190-19a4-4f50-b615-7a9a78b8ff14, version sortir-scheduler-lock-v1 : **completed**, disponible ; pas d’état running durable.
- **0 ingestion running, 0 source run running, 0 lot historique dans le journal**. Aucun verrou d’écriture Sortir et aucune session dédiée présents lors du dernier contrôle. Une session visible pendant le contrôle initial correspondait à la relecture READ ONLY en cours ; elle n’est plus présente après fermeture de la connexion.
- Compteurs inchangés depuis la vérification d’installation : **79 571 activités, 80 287 provenances, 240 283 external IDs, 809 ingestion runs (dont le mutex technique), 839 source runs**.
- Statuts : **38 342 active, 39 490 review, 1 735 stale, 4 merged**. Empreintes sur toutes les colonnes des activités, provenances et external IDs identiques au contrôle après initialisation du verrou.
- Fonction de verrouillage, ACL et politiques RLS inchangées. **12 politiques**, **5 contraintes du journal**, **1 index de clé primaire**. Le writer ne peut modifier que record_status et updated_at ; aucune création/suppression d’identité autorisée. SELECT/INSERT journal et EXECUTE de la fonction réservés au rôle writer, inaccessibles directement au login, anon, authenticated et service_role.
- Aucun rôle privilégié ou BYPASSRLS ajouté. Le login passe explicitement au rôle writer ; aucun élargissement de permissions.

## 2. Scheduler : ce qui explique l’absence de tick observable

Configuration distante de auto-collect.yml identique à celle auditée localement et présente sur **main**, branche par défaut. Dépôt public, ni archivé ni désactivé ; activité récente au 28 octobre. Workflow **active**, Actions **enabled**, actions autorisées. Le cas de désactivation automatique par inactivité n’est donc pas constaté.

Cron : toutes les cinq minutes. Le serveur attend **04:00 Réunion**, fuseau Indian/Reunion, et accepte les ticks jusqu’à **04:40 exclu**, soit **00:00 <= UTC < 00:40**.

Les **100 runs** consultés sont terminés avec succès, aucun run en attente ni échec enregistré. Autour de la fenêtre :
- 28 octobre **23:24:34 UTC** : run 40787156337 ;
- 29 octobre **02:33:38 UTC** : run 40807073715 ;
- dernier disponible : 29 octobre **08:50:40 UTC**, run 40845079273, terminé à 08:50:48 UTC.

**Aucun run créé ou démarré dans la fenêtre 00:00–00:40 UTC.** Le dernier journal Sortir montre HTTP 200, triggered=false, reason=not due. Le serveur sort sur ce contrôle horaire avant acquisition du verrou et avant ingestion. Le verrou absent précédemment ne pouvait donc pas avoir empêché ces ticks de s’exécuter : ils n’ont pas atteint l’étape de verrouillage.

La cause applicative visible est précise : **aucun déclenchement GitHub observable dans la fenêtre, puis rejet des ticks reçus hors fenêtre par le contrôle horaire**. Les logs disponibles n’expliquent pas pourquoi GitHub n’a pas produit de run dans cette fenêtre ; ils ne permettent pas de distinguer une omission d’un déclenchement retardé en amont. Aucun défaut TLS, refus du verrou, erreur HTTP ou échec de job n’est montré dans ces runs.

GitHub documente la possibilité de retarder ou d’abandonner des événements schedule sous charge : https://docs.github.com/en/actions/how-tos/troubleshoot-workflows . C’est une explication possible, **pas une cause démontrée pour cet incident**. Une attribution interne précise exigerait les journaux de la plateforme ou un diagnostic du fournisseur. Cette incertitude ne manque pas à la preuve d’exclusion du pilote, dont le verrou fonctionne indépendamment de la livraison des ticks.

Aucun tick manuel, aucun workflow déclenché ou modifié. Fiabilité quotidienne : toujours à confirmer.

## 3. Snapshot, plan et nouveau dry-run

Les **10 fichiers du snapshot** ont tous leurs SHA-256 conformes. L’ancien état opérationnel du snapshot (verrou alors absent) n’a pas été réutilisé : il est remplacé par les lectures actuelles. L’ajout autorisé du mutex n’est pas une modification des données des 75 dossiers.

Plan inchangé : **b866b229d2079a0c70bbd6799ffeb61e4ff726542fcd609cda084cc3abd84118**.
CodeHash inchangé : **7c78467c1410148dc831305f7a9c879eaaff06bdbe493f95ac38a9623c5421e4**.
SnapshotKey : **48bf0ffb4fc8ae98545d410f43bc06b4cbdfb877cb4f6839ddc94278a6295ab0**.
75 entrées, un seul batch de taille 75, toutes prévues PROMOTE. Le hash du plan ne constitue pas une autorisation d’exécution.

Recalcul complet des 75 depuis la base courante, avec les mêmes règles que le writer, sans appel à writeBatch :

| Contrôle | Précédemment validé | Nouveau contrôle |
|---|---:|---:|
| Décisions DISTINCT / PROMOTE simulé | 75 | 75 |
| Quarantaines | 0 | 0 |
| Autres ambiguïtés ou nouveaux MATCH | 0 | 0 |
| Empreintes des dossiers conformes au plan | 75 | 75 |
| Statuts réels REVIEW | 75 | 75 |
| Provenances | 75 | 75 |
| External IDs | 225 | 225 |
| Candidats rechargés | 16 506 | 16 506 |
| Comparaisons | 20 396 | 20 396 |
| Écritures réelles | 0 | 0 |

Les raisons des décisions sont identiques, diagnostics cibles conservés, aucune nouvelle quarantaine ou autre validation bloquante selon les règles actuelles. Identités, provenances, external IDs, intervalles et regroupements stockés sont couverts par les fingerprints conformes. La simulation change uniquement le statut ; le writer réel est désactivé et n’a pas été invoqué.

## 4. Explorer : regroupement stable, mais arrêt sur le zonage

La projection de **79 571 activités** comprenant identité, titre, ville, postal_code, adresse, lieu, intervalles et statuts est identique au snapshot d’origine. Les clés seriesKey des 75 dossiers sont inchangées.

Avec la fonction réelle lib/explorer.js seriesKey, sans filtre géographique et au même instant logique : **23 219 groupes publiables actuellement**, **23 281 après simulation**, soit **62 groupes supplémentaires pour 75 occurrences**. Le regroupement simulé est identique sur l’ancien snapshot et sur la base relue. Il s’agit d’un comptage national de groupes futurs/en cours avant zonage et pagination, pas d’une réponse API ou d’une publication réelle. Le regroupement d’affichage ne fusionne aucune séance en base.

Ce contrôle national ne démontrait pas l’acceptation par les filtres géographiques. Le contrôle complémentaire avec la fonction réelle lib/explorer-geo.js departmentScope donne **71 acceptés, 4 rejetés**. Les quatre rejets concernent :

| ID | Titre | Commune | postal_code stocké | Statut réel |
|---|---|---|---|---|
| 611d18de-c5df-4f90-bad8-a5c0ccaf7f71 | Jazz sur la ville | Marseille | 13055 | REVIEW |
| 4560b6b9-95a0-41b5-a00e-1e48adc99540 | Jazz sur la ville | Marseille | 13055 | REVIEW |
| 431ea32c-9d0b-423e-bae8-6990c19ff2a6 | Jazz sur la ville | Marseille | 13055 | REVIEW |
| 59f5681f-cf27-4384-bf1d-85dda6153a27 | Jazz sur la ville | Marseille | 13055 | REVIEW |

Pays FR, coordonnées 43.294924 / 5.372668 pour ces quatre occurrences. Le département 13 refuse ces lignes via son référentiel postal/communal. **Le postal_code 13055 est bien déjà présent dans le snapshot : ce n’est ni une modification récente ni une altération du writer.** Il n’est pas établi ici si la valeur source est inadéquate, si la normalisation initiale est en cause ou si le référentiel Explorer doit reconnaître ce cas. Aucun code postal de remplacement n’a été inventé.

L’arrêt intervient à ce stade : aucun lot recomposé, aucun dossier retiré/remplacé et aucun correctif métier ou géographique appliqué. La preuve de publication géographique correcte de l’ensemble du lot reste donc incomplète, malgré les 75 décisions DISTINCT valides.

## 5. Sécurité du writer confirmée par lecture du code et preuves existantes

- writeBatch appelle la **fonction de production sortir_organizer_recovery_lock()** dans BEGIN et vérifie les dix SHARE ROW EXCLUSIVE réellement détenus, le mutex completed, la visibilité RLS complète et l’absence de runs actifs.
- Le lot entier est rechargé et revalidé **avant le premier UPDATE**, sous exclusion. Toute empreinte modifiée ou éligibilité perdue provoque ROLLBACK.
- UPDATE limité à record_status/updated_at. Rerelecture et empreintes immuables après les UPDATE ; contrôle des compteurs d’identités et des statuts avant validation.
- Journal et checkpoint insérés dans la **même transaction** que les promotions. Clé primaire (plan_hash,batch_number), request_hash et contenu du checkpoint vérifiés au replay. Une interruption avant COMMIT annule le lot ; après COMMIT, le replay reconnaît le journal et ne réapplique pas les promotions.
- CLI fermé par défaut : --apply, plan exact, autorisation de hash et variable d’autorisation d’écriture explicites ; compte dédié TLS obligatoire. Aucun de ces mécanismes n’a été activé ici.

Preuves conservées de l’étape d’installation : exclusion de deux processus en production, SQLSTATE 55P03, acquisition scheduler bloquée pendant la détention puis possible après, SIGKILL et reprise en 1 005 ms, dix verrous confirmés. La définition de fonction et les permissions actuelles sont identiques à celles testées.

Validation hors production précédente : **749 cas dans 47 suites**, plus **25 tests PostgreSQL natifs**, dont rollback, interruption, replay, checkpoints, RLS et interdiction des mutations d’identités. Le codeHash actuel correspond au code validé. Ces suites ne sont pas présentées comme relancées dans cette intervention de lecture seule.

## 6. État final et preuve manquante

Dernière lecture opérationnelle : zéro ingestion running, zéro source running, zéro session de reprise, aucun verrou d’écriture Sortir et journal de reprise vide. Aucun état running supprimé ou réinitialisé.

La condition manquante est circonscrite aux quatre dossiers Jazz sur la ville : expliquer le rejet du code 13055 et déterminer leur traitement conforme à la source et au zonage, sans inventer de donnée. Le défaut de tick quotidien reste un sujet opérationnel distinct et n’est pas utilisé pour bloquer artificiellement la sécurité transactionnelle du pilote.

Preuves durables : sortir/recovery-data/2026-10-29-pilot-decision/. STOP-geographic-validation.json identifie les quatre dossiers. pilot-live-verification.json, pilot-comparison.json et explorer-grouping-verification.json distinguent les protections validées de la validation géographique échouée. Aucun secret enregistré.

État Git : nouveau rapport uniquement dans cette intervention ; les modifications préexistantes sont conservées. Détail dans git-status.txt. Aucun commit/push.

**C — INVESTIGATION NÉCESSAIRE**

Aucune promotion n’est autorisée par ce rapport. Arrêt en attente de votre décision explicite.
