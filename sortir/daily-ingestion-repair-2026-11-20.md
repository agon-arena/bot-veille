# SORTIR — réparation quotidienne préparée, 20 novembre 2026

## Livraison et périmètre

Correctif local uniquement. Aucune écriture Supabase, ingestion réelle, promotion, relance,
augmentation Render, publication, commit ou push effectué. Aucun appel IA ajouté à SORTIR.
Les modifications préexistantes de medias.json et youtube-chaines.json sont préservées.
Le bot déployé reste afc3eb369d55e281d778a25ce893dad3805a0a39 : ce correctif n'est pas déployé.

## 1. Cause et certitude

Les lectures de production ont été séquentielles, avec read_only=true, et complétées par
les journaux GitHub et la configuration Render.

- Run interne caa4ae36-7a50-464a-aaed-52b1f14523e7 : sortir-ingestion-v1, démarré le
  10/11 à 14:05:19.738 Réunion, running sans finished_at, compteurs à zéro.
- Source interne 429db29b-6e01-4fea-9ea0-48ae9dad16e8 : partial, 1 512 collectés,
  812 VALID, 624 NEEDS_REVIEW, 76 INVALID. Erreur : élément 1019, Fusion refusée: décision REVIEW.
- Il existe effectivement 1 512 items de collection, liés à 1 433 activités distinctes.
  Il ne s'agit pas de 1 433 créations. Horodatages des items : 14:06:12.424227 à
  14:06:37.442707 Réunion le 10/11. L'enveloppe mesure une création.
- Enveloppe producteur 98ba8d8b-dc88-4ba6-8e12-cf6cfa1ef6b7 et source enveloppe
  0fd2890c-1181-4594-af80-c1a4af53a318 : failed, fermées à 14:06:46.077 Réunion.
- Cycle 19618a6c-a628-4631-9781-5141c6d58f93 : failed, fermé à 14:06:46.761 Réunion.
- Leur message d'exception est Erreur non précisée. Le mutex est completed. Le journal
  GitHub confirme another ingestion running, puis BLOCKED sans libération automatique.

Cause structurelle démontrée : après la clôture du run source, le persisteur appelle
countFinalActivities(), puis updateIngestionRun(), sans clôture de secours autour de cette
séquence. Une exception y laisse le run interne running, même si l'enveloppe et le cycle
se ferment. La lecture de ce seul run suffit ensuite à bloquer tous les cycles.

Point non démontré : lequel de ces deux appels a échoué le 10/11, et si la cause était
un timeout, une rupture réseau ou une réponse de clôture perdue. L'erreur REVIEW est
capturée normalement et explique le partial, pas à elle seule le blocage. Aucun OOM
n'est démontré pour ce cycle : le producteur et le cycle ont encore pu se fermer.

Au contrôle : zéro autre run/source running, zéro requête SQL active hors audit.
L'enveloppe failed prouve que le persisteur attendu a rendu la main ; le déploiement
Render du 15/11 est postérieur. Ces éléments établissent l'arrêt du propriétaire de
l'appel du 10/11. Ils ne remplacent pas un contrôle frais des autres exécuteurs avant
une future écriture : refaire les contrôles sous exclusion, jamais sur l'âge seul.

DATAtourisme : sa clé DATATOURISME_API_KEY n'est pas configurée sur Render ; aucun groupe
d'environnement ni fichier secret n'est lié. Le code exige cette clé pour ajouter ce
producteur. Une clé locale ne configure pas Render. Rien n'est réintroduit.

## 2. Fichiers du correctif

Code quotidien :
- sortir-auto-ingest.js
- sortir/daily-run-lifecycle.js (nouveau)
- sortir/scheduler-cycle-status.js

Tests :
- test-sortir-scheduler-reunion.js (test de clôture durablement impossible adapté)
- sortir/test-daily-run-lifecycle.js
- sortir/test-daily-run-reconciliation.js
- sortir/test-helpers/daily-interruption-worker.js

Préparation et rapport :
- sortir/reconcile-daily-run-20261110.sql
- sortir/daily-ingestion-repair-2026-11-20.md

## 3. Fonctionnement du correctif

Un décorateur du store quotidien suit uniquement les IDs créés par l'invocation en cours.
Après retour ou échec du travail attendu, il clôt ses runs internes restés ouverts, sans
scanner ni fermer les runs appartenant à un autre processus.

- Un comptage final en échec n'empêche plus la tentative de clôture failed.
- Les compteurs connus et les erreurs source sont conservés. Les erreurs initiales,
  leur étape et les erreurs secondaires sont journalisées, avec expurgation des secrets.
- Les UPDATE de clôture réutilisent les retries transitoires existants : même ID et même
  patch, date comprise. Aucun INSERT ou traitement métier n'est automatiquement rejoué.
- Une réponse métier perdue, un ID de création non confirmé ou une clôture durablement
  impossible impose operatorActionRequired, interdit les écritures métier suivantes
  et conserve le mutex ; aucun producteur suivant ne démarre.
- Le cycle reçoit un UUID avant son INSERT : une réponse perdue conserve une identité
  réconciliable et ne provoque pas la libération du mutex.
- Une erreur ordinaire déterminée permet au rattrapage quotidien de fonctionner après
  clôture ; les tests vérifient l'absence de double activité/provenance.
- Les partial métier existants restent conservés et ne sont pas assimilés à completed.
- La supervision signale abandonmentSuspected après 40 minutes, mais expose toujours
  automaticRecoveryAllowed:false. Un traitement ancien n'est pas automatiquement mort.

Pas de dépendance, heartbeat, bail ou architecture nouvelle. Le mutex partagé, la queue,
les bornes mémoire, les transactions, les clés d'occurrence et le dédoublonnage existants
sont préservés. Les diagnostics conservés par le décorateur sont limités à 32 entrées.

Les fichiers scellés, dont supabase-persistence.js et scheduler-state.js, sont inchangés.
Les douze plans locaux passent leur vérification. CodeHash préservé :
1b1feff8f66eb18f10176c9ce15b753a331672dfcc2a17fc647c429608452a74.

## 4. Tests hors ligne

- 84 tests ciblés : lifecycle, scheduler, clôture, rattrapage, monitor, Réunion et Paris.
- 8 tests PostgreSQL embarqué : annulation par défaut, modification simulée des deux
  métadonnées attendues, refus de mutex vivant, autre run vivant, source active,
  preuve modifiée/manquante, items modifiés ou cible déjà fermée.
- Régression supplémentaire : onze fichiers, dix-sept résultats au niveau du runner
  Node, avec les assertions internes de leurs anciens harnais, tous réussis.
- SIGKILL réel d'un enfant de test après création des runs : un nouveau worker ne reprend
  et ne clôt pas ses lignes running. Cet enfant est isolé et ne contacte aucun service réel.

Suites :

```sh
node --test sortir/test-daily-run-lifecycle.js sortir/test-scheduler-daily-catchup.js sortir/test-scheduler-cycle-close.js sortir/test-scheduler-repair.js sortir/test-monitor-scheduler.js test-sortir-scheduler-reunion.js sortir/test-paris-scheduler.js
node --test sortir/test-daily-run-reconciliation.js
env -u SORTIR_WRITER_TEST_DATABASE_URL node --test test-sortir-auto-ingest.js sortir/test-supabase-persistence.js sortir/test-openagenda-json.js sortir/test-openagenda-reunion-v1.js sortir/test-paris-events.js sortir/test-candidate-prefilter.js sortir/test-known-provenance-fast-path.js sortir/test-known-provenance-batch-preload.js sortir/test-known-provenance-batched-writes.js sortir/test-new-occurrence-collection-items-batch.js sortir/test-datatourisme-write-behind.js
```

Aucun client Supabase réel ni .env de production chargé par ces tests : stores mémoire,
HTTP factice/local et PGlite. Zéro ingestion réelle.

## 5. Déblocage exact préparé — NE PAS EXÉCUTER sans autorisation

1. Obtenir séparément l'autorisation de déployer le correctif. Vérifier ensuite son SHA
   réellement actif ; ne pas libérer le run avant cette vérification.
2. Obtenir l'autorisation d'écrire la clôture et de réserver temporairement le mutex.
   Refaire les lectures des cinq lignes, des 1 512 items et des 1 433 identités, ainsi
   que les contrôles de processus Render, locaux et d'autres exécuteurs éventuels.
3. Sur une connexion PostgreSQL directe/session unique, utiliser une copie revue de
   reconcile-daily-run-20261110.sql. Ce fichier finit volontairement par ROLLBACK.
   Seule une copie explicitement autorisée peut remplacer cette dernière instruction
   par COMMIT. Ne jamais renouveler les empreintes pour contourner une divergence.
4. Le SQL force UTC pour comparer les empreintes, prend les exclusions NOWAIT sur les
   neuf tables d'ingestion, exige le mutex completed, aucun autre run/source running,
   les cinq empreintes inchangées et les compteurs/identités attendus. Tout écart arrête
   la transaction sans modification persistante.
5. Deux lignes techniques changent atomiquement : le run interne devient failed avec
   les quatre compteurs source reconstruits et son erreur conservée ; le mutex devient
   running, marqué sortir_daily_maintenance / 20261120-daily-repair-caa4ae36 / prepared.
   Le mutex de maintenance empêche le prochain tick GitHub de lancer le cycle complet.
6. Les compteurs merged_count, review_count et final_count non reconstructibles sont
   explicitement signalés inconnus. Aucun événement, provenance ou ID n'est supprimé
   ou réécrit. Les autres runs et les plans/checkpoints historiques restent inchangés.
7. Relire les deux lignes et les preuves après commit. Si la réponse COMMIT est perdue :
   réconciliation en lecture seule, jamais de replay immédiat de l'opération.

L'état approprié du vieux run est failed, pas completed : sa source est partial, son
producteur et son cycle sont failed. Ses écritures déjà effectuées doivent être conservées.
Le mutex de maintenance ne doit pas être nettoyé comme un run abandonné.

## 6. Test réel limité préparé — autre autorisation requise

Périmètre proposé : un seul producteur existant, Réunion 2568169, maximum trois événements
et six cents occurrences, par tranches de cent. Aucun Paris, autre agenda, DATAtourisme,
appel IA, disparition ou promotion historique. Vérifier d'abord en lecture seule que la
source convient encore ; une collecte vide ne valide pas l'idempotence des écritures métier.

Avant : vieux run failed, zéro autre run/source actif, mutex de maintenance exact prepared,
SHA corrigé vérifié. Relever les compteurs et identités de cette seule source.
Un unique opérateur réserve la phase testing par comparaison conditionnelle sous verrou
NOWAIT ; exiger une seule ligne avant un éventuel COMMIT autorisé :

```sql
BEGIN;
SET LOCAL lock_timeout='1s';
SELECT id FROM public.sortir_ingestion_runs
WHERE id='be127190-19a4-4f50-b615-7a9a78b8ff14' FOR UPDATE NOWAIT;
UPDATE public.sortir_ingestion_runs
SET error_summary='[{"kind":"sortir_daily_maintenance","token":"20261120-daily-repair-caa4ae36","phase":"testing"}]'::jsonb
WHERE id='be127190-19a4-4f50-b615-7a9a78b8ff14'
AND status='running' AND orchestrator_version='sortir-scheduler-lock-v1'
AND error_summary='[{"kind":"sortir_daily_maintenance","token":"20261120-daily-repair-caa4ae36","phase":"prepared"}]'::jsonb
RETURNING id;
-- Une ligne obligatoire ; tout autre résultat exige ROLLBACK.
ROLLBACK;
```

Dans le seul processus réservé, utiliser scheduledSource avec le store existant et
runReunionProducer pour cet agenda, sans appeler le tick général ou monitor-scheduler.
Le fetchEvents fourni doit appeler le connecteur avec maxEvents=3, pageSize=3 et
occurrenceBatchSize=100, relayer onBatch vers le producteur mais lever une erreur dès
que le cumul dépasse 600. Refuser aussi fetched.truncated avant de rendre la collecte.
Ainsi aucune sélection silencieusement tronquée n'est persistée ; la collecte est bornée
avant toute écriture d'événement, et le persisteur Réunion n'applique pas de disparitions.

Après : attendre le retour ; vérifier inner/producteur/source terminés, compteurs,
provenances et absence de doublon d'occurrence. Si operatorActionRequired ou résultat
incertain : laisser la maintenance, réconcilier, aucun deuxième appel automatique.
Un rejeu explicite autorisé d'un premier résultat certain doit conserver les IDs des
activités et provenances ; de nouveaux items de journal de collecte sont normaux.

## 7. Retour au quotidien complet

La libération du mutex peut déclencher les neuf producteurs au tick suivant : elle exige
une autorisation de retour au quotidien, pas simplement celle de tester une source.
Vérifier auparavant l'arrêt du test et zéro autre run/source actif. L'UPDATE de libération
doit comparer l'ID, la version, status=running et le marqueur testing exact, passer à
completed, finished_at=clock_timestamp(), error_summary=[] et exiger une ligne.
Ne pas libérer automatiquement dans un finally d'opérateur.

Validation complète : neuf producteurs attendus, cycle durable completed, completedCount
égal à expectedCount, zéro pending/failed/partial, mutex completed, zéro run/source running,
et supervision GET successConfirmed=true. Un second tick du jour doit ignorer les sources
completed ; seul un producteur en échec ordinaire doit être retenté après l'espacement.
Observer ensuite 24–48 h. DATAtourisme reste hors de ce cycle.

## 8. Risques résiduels et offre Render

Les erreurs ordinaires déterminées disposent désormais d'une clôture de secours. Un
SIGKILL/OOM, une panne persistante du journal ou une écriture métier à réponse perdue
peuvent encore nécessiter une réconciliation contrôlée. Sans mécanisme durable de fencing,
fermer un run sur son âge risquerait de concurrencer un vrai worker : ce choix est exclu.

Aucune concurrence distante multi-session, charge Render ou coupure réelle Supabase n'a
été testée. La validation locale n'est pas une validation d'exploitation en production.

Une offre Render payante n'est pas nécessaire pour résoudre ce blocage logique. Elle
peut améliorer la disponibilité et donner accès aux métriques du bot Free. Le Starter
à 7 USD/mois reste à 512 Mo et n'augmente pas la RAM. Décider d'une capacité supérieure
seulement après mesure du cycle corrigé. Aucune augmentation n'est effectuée.
