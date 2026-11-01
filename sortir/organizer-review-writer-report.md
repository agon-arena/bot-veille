# Writer historique organizer_name_missing — validation du 29 octobre 2026

**Writer implémenté et validé hors production. Lancement réel non autorisé.**

Aucune connexion Supabase, écriture Supabase, ingestion ou migration de production
n'a été exécutée pendant cette intervention. Aucune modification du scheduler,
du comparateur, du filtrage Explorer ou de la correction précédente. Aucun
commit/push ni staging Git.

## 1. Fichiers concernés

Fichiers suivis modifiés :

- `package.json`, `package-lock.json` : driver PostgreSQL `pg@8.23.1` ;
  `@electric-sql/pglite@0.5.13` en dépendance de développement seulement.
- `sortir/run-organizer-review-dry-run.js` : export de l'historique de diagnostics,
  préparation d'un plan scellé et délégation au writer uniquement sur `--apply`.
- `sortir/test-organizer-review-recovery.js` : vérification du nouveau refus
  sécurisé de `--apply` incomplet.
- `sortir/organizer-review-recovery-plan.md` : mise à jour, historique conservé.

Nouveaux fichiers :

- `sortir/organizer-review-writer.js` : scellement, empreintes, transactions,
  revalidation courante et contrôles d'intégrité.
- `sortir/run-organizer-review-writer.js` : CLI explicitement autorisé.
- `migrations/2026-10-29-sortir-organizer-recovery-journal.sql` : proposition de
  journal/checkpoints, fonction de verrouillage et rôle limité.
- `sortir/test-helpers/organizer-writer-fixture.js` : fixtures SQL hors production.
- `sortir/test-organizer-review-writer.js` : tests SQL, CLI et concurrence réelle.
- `sortir/organizer-review-writer-validation.json` : résultats structurés.
- `sortir/organizer-review-writer-report.md` : présent rapport.

## 2. Mode d'écriture, désactivé par défaut

Le CLI existant reste **dry-run par défaut**, sans lecture de credentials.
`--prepare-write-plan FICHIER` crée un nouveau plan, seulement après un dry-run
complet sans erreur. Il contient la liste fermée d'IDs, les décisions
PROMOTE/RETAIN_REVIEW, les empreintes attendues, le snapshot, le code/migration
et la taille des lots (1 à 100, 75 par défaut pour le writer).

Le fichier de plan est scellé par SHA-256 canonique. Le scellement est stable
entre formats d'horodatage et ne dépend pas de la locale. Changement de code,
de migration, d'IDs ou de décisions : nouvelle autorisation nécessaire.

L'écriture nécessite simultanément :

1. `--apply` ;
2. `--write-plan FICHIER` ;
3. `--authorize-plan-sha256 HASH_EXACT` ;
4. `SORTIR_RECOVERY_ALLOW_WRITE=I_AUTHORIZE_EXACT_PLAN` ;
5. `SORTIR_RECOVERY_DATABASE_URL`, connexion PostgreSQL explicitement fournie.

Aucun `.env` chargé automatiquement, aucun fallback sur les clés REST Supabase,
aucun endpoint HTTP ajouté. Le CLI prend le rôle limité
`sortir_organizer_recovery_writer` après connexion. Sans rôle/migration,
autorisation ou plan corrects : arrêt. Par défaut, **un seul nouveau lot** est
traité ; les lots confirmés peuvent être relus pour retrouver le checkpoint.
Aucune de ces commandes d'écriture n'a été exécutée sur une base de production.

## 3. Transaction atomique par lot

Le writer utilise une connexion PostgreSQL dédiée, pas une succession de PATCH
REST présentée comme une transaction.

1. `BEGIN`, bornes de temps SQL/verrous/transaction inactive.
2. Verrouillage `SHARE ROW EXCLUSIVE NOWAIT` des dix tables de support : activités,
   provenances, external IDs, diagnostics, décisions, sources, runs d'ingestion,
   runs sources, états POI et journal de reprise.
3. Vérification des verrous effectivement détenus dans `pg_locks`. La fonction
   privilégiée retourne aussi les compteurs complets de visibilité : les comptes
   du rôle appelant doivent correspondre. Une politique RLS qui cacherait des
   candidats provoque un arrêt, jamais une comparaison silencieusement incomplète.
4. Contrôle de la ligne technique du scheduler existant (ID et version exacts,
   statut completed) et absence de tout run d'ingestion/source running.
5. Lecture du checkpoint du lot, ou lecture des activités et de **tous les
   candidats actuels dans leurs fenêtres temporelles**, avec provenances/payloads,
   identifiants, sources, diagnostics et décisions.
6. Empreinte de chaque activité ciblée comparée au dry-run. Toute différence
   provoque le rollback du lot, même si la ligne semble encore éligible.
7. Réévaluation à l'heure actuelle de PostgreSQL par le validateur, l'index,
   `rowToActivity`, le comparateur et la quarantaine existants. Aucune fusion.
   Une promotion prévue devenue ambiguë, expirée ou MATCH annule tout le lot.
   Une entrée RETAIN_REVIEW reste REVIEW, même si elle paraît désormais éligible.
8. Seulement après validation du lot entier : modification de
   `record_status='active'` et `updated_at` pour les PROMOTE admissibles.
9. Relecture des lignes/relations avant COMMIT : mêmes champs métier,
   provenances complètes, external IDs, payloads, diagnostics et décisions ;
   seuls statut et updated_at sont autorisés à évoluer. Un trigger SQL qui
   changerait un horaire est détecté et le lot est annulé.
10. Vérification des compteurs globaux avant/après, insertion du journal/checkpoint
    du lot dans **la même transaction**, puis COMMIT.

Il n'existe aucun INSERT/DELETE d'activité, provenance ou external ID dans le
writer, et le rôle n'en a pas les droits. Le diagnostic et son historique sont
conservés. Les champs qui déterminent les regroupements et les intervalles sont
comparés après écriture, pas seulement supposés inchangés.

## 4. Exclusion du scheduler et des ingestions concurrentes

Le verrou technique existant du scheduler est respecté sans modifier son code,
son horaire ou son état depuis le writer. S'il est running, le lot est refusé.
Les verrous de tables empêchent également les writers manuels qui ne prennent
pas ce verrou technique de modifier les données pendant la transaction.

Un writer d'ingestion déjà engagé fait échouer NOWAIT immédiatement. Une
acquisition du scheduler arrivant pendant un lot ne peut aboutir qu'après sa
fin : elle attend ou atteint son délai d'attente, sans chevauchement des écritures.
Entre deux lots, le scheduler peut démarrer ; le lot suivant sera alors refusé.
Aucune expiration de verrou, prise de force ou retry aveugle.

La fonction SECURITY DEFINER ne reçoit aucun SQL/nom de table utilisateur et ne
modifie aucune activité : verrouillage, contrôle des runs et comptes de visibilité
uniquement. Les accès PUBLIC/anon/authenticated/service_role sont révoqués.
Le rôle NOLOGIN dédié dispose de SELECT, UPDATE(record_status,updated_at) et
INSERT/SELECT du journal, avec politiques RLS explicites. Un login opérateur doit
recevoir ce rôle séparément ; aucun compte ou secret de production n'a été créé.

## 5. Reprise et idempotence

Le checkpoint est la PK `(plan_hash,batch_number)` dans
`sortir_organizer_recovery_batches`. Il contient le hash de requête, les compteurs
avant/après et le journal individuel (IDs, motif, empreinte, statuts, updated_at
avant/après). Les checkpoints locaux du dry-run ne font jamais foi pour écrire.

- Interruption avant COMMIT : activités et checkpoint sont annulés ensemble.
- COMMIT réussi mais réponse perdue : le replay retrouve le résultat confirmé.
- Second replay : zéro nouvelle promotion, mêmes activités et relations.
- Checkpoint incohérent ou contenu incomplet : arrêt, aucune réinterprétation.
- Changement de version du code : le plan est refusé. Geler le code pendant la
  reprise ; ne pas contourner cette protection pour reprendre un ancien plan.

Compteurs : examinés, nouvellement ACTIVE, maintenus REVIEW, quarantaines,
autres ambiguïtés, erreurs, déjà traités et compteurs globaux avant/après. Les
résultats rejoués sont marqués `replayed:true` et `newlyActivated:0`. Les erreurs
sont signalées avec arrêt du CLI et aucune progression fictive du checkpoint.

## 6. Résultats des tests hors production

**PostgreSQL natif local 18.4 : 22 tests réussis, 0 échec, 0 ignoré.**
Trois connexions à la base isolée `organizer_writer_test` sur 127.0.0.1,
avec le rôle limité pour le writer. La migration a été testée dans cette base
locale uniquement. Le même noyau transactionnel est aussi testé sous PGlite.

Cas couverts :

- autorisations manquantes, plan altéré, doublon, promotion forcée d'une sensible ;
- préparation réelle par le CLI dry-run, puis consommation du plan par le writer ;
- 75 dossiers : 50 ACTIVE / 25 REVIEW, 646 hors diagnostic inchangés ;
- interruption après 23 UPDATE puis reprise complète ;
- erreur SQL (division par zéro), erreur avant COMMIT et rollback intégral ;
- réponse perdue après COMMIT, replay et absence de doublon de journal ;
- checkpoint incohérent ;
- activité changée, nouvelle quarantaine, nouveau MATCH : refus du lot ;
- trigger SQL modifiant l'horaire : détection et rollback ;
- fonction de verrouillage absente ;
- interruption/reprise entre trois lots de 25 ;
- scheduler/source run running ;
- deux sessions : ingestion déjà engagée ; acquisition du scheduler pendant le lot ;
- RLS restrictive masquant un candidat ;
- privilèges : création/suppression d'identités et modification des dates refusées.

Le lot de 75 est une **fixture représentative**, pas une écriture sur les anciens
75 dossiers réels. Les fixtures contiennent 732 activités au total (candidats et
646 hors diagnostic inclus) ; ces identités, leurs relations, payloads et
l'historique sont comparés avant/après. Les tests ne prétendent pas reproduire
les 230 external IDs du précédent pilote réel archivé.

La suite complète Sortir + scheduler est détaillée dans le JSON de validation :
**45 suites réussies, aucun échec**. Aucun seuil ou comportement du comparateur,
d'Explorer ou des connecteurs n'a été modifié.

Explorer, dépôt applicatif séparé : **81/82 tests passent**. Le seul échec est
l'ordre frontend « Course / Exposition / Réunion publique ». Il est reproduit
sur une copie du **HEAD du dépôt Explorer**, sans writer et sans modifications
locales : préexistant, hors périmètre. Les tests HTTP ont été rejoués avec les
permissions loopback et le bon répertoire ; les erreurs initiales de sandbox ne
sont pas comptées comme régressions. Aucun fichier de ce dépôt n'a été modifié.

## 7. Comparaison nationale : référence, pas nouvelle mesure live

Référence conservée dans `organizer-review-validation-results.json` :
35 899 concernés = **35 269 DISTINCT + 630 REVIEW**, zéro nouveau MATCH ;
36 545 REVIEW moins les concernés = **646 hors diagnostic**.
Le test compare ces compteurs de référence et le partage pilote 50/25.

**Limite :** les anciens snapshots `/tmp/explorer-organizer-review-20261028` et
le fichier d'IDs du pilote ne sont plus présents. Aucun nouveau snapshot de
production n'a été acquis et aucune simulation nationale live n'a été inventée.
Les 630 dossiers réels n'ont donc pas été revérifiés individuellement pendant
cette étape. Le writer protège cette population par décisions scellées, contrôle
des diagnostics et revalidation courante, pas par une whitelist artificielle de
35 269 IDs. Les nombres peuvent changer avec les dates et les données.

## 8. Migration nécessaire et prérequis réels

La migration préparée reste **NON APPLIQUÉE en production**. Elle crée uniquement
le journal/checkpoint, le rôle NOLOGIN, les droits/politiques RLS et la fonction
de verrouillage. Elle ne promeut aucune activité et n'altère aucun intervalle.

Avant tout premier lot réel :

1. revue et autorisation explicite de cette migration et du provisionnement d'un
   login PostgreSQL dédié ; vérifier la compatibilité avec le schéma/RLS réels ;
2. acquisition d'un snapshot frais, complet et stable, nouveau dry-run avec une
   liste fermée de dossiers REVIEW, puis scellement du plan avec le code final ;
3. validation des compteurs et autorisation séparée du **hash exact du petit lot** ;
4. aucun déploiement/changement de code en cours ; traiter au maximum un lot
   initial, observer le journal et Explorer avant toute suite nationale.

Risques résiduels : attente ou refus du scheduler pendant les verrous (durée
bornée, pas d'écritures concurrentes), besoin d'un accès PostgreSQL direct,
compatibilité du rôle et des politiques avec la production non testée ici,
obsolescence des plans au passage du scheduler, échec Explorer préexistant.
Un lot trop large ou lent doit être réduit après mesure sur le pilote, jamais
contourner les protections ou allonger aveuglément les délais.

## 9. Git et arrêt

Branche **main**, HEAD **3539d309fe660a7aab4f8696e77fe46ca5f0fb81**, inchangé pendant
cette intervention. Dépôt propre au départ. Cinq fichiers suivis modifiés, sept
nouveaux fichiers non suivis, rien stagé. Aucun commit/push. Syntaxe et
`git diff --check` valides. L'état détaillé et les empreintes figurent dans le
JSON de validation ; le rapport et ce JSON complètent les douze fichiers.

Le writer est validé techniquement hors production. **Il n'est pas exécutable
sur un lot réel dans l'état actuel : migration/rôle et plan réel frais manquent.**
Aucune autorisation d'écriture réelle n'est demandée ou déduite de ces tests.

**WRITER HISTORIQUE PRÊT POUR PETIT LOT RÉEL : NON**
