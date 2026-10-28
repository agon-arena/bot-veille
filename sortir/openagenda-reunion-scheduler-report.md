# Branchement quotidien OpenAgenda Réunion V1 — correction et tests

28 octobre 2026. **PRÊT POUR COMMIT/PUSH : OUI**, pour revue du code et des tests. Aucun commit, push, déploiement, redémarrage serveur, cron réel, ingestion réelle ou migration n'a été exécuté pendant cette intervention. Le branchement est présent dans le code local ; la production n'a pas été modifiée.

## Fichiers de cette intervention

| Fichier | Changement |
|---|---|
| `sortir-auto-ingest.js` | Orchestration séquentielle par producteur, isolation des erreurs, reprise indépendante, compteurs observés, statuts globaux exacts, acquisition/libération du verrou |
| `sortir/scheduler-state.js` | Verrou partagé atomique et recherche de passage complet par source |
| `sortir/openagenda-reunion-daily.js` | Appel du connecteur et du chemin V1 validés pour les cinq producteurs |
| `sortir/openagenda-reunion-v1.js` | Commentaire actualisé seulement ; producteurs, décisions et règles métier inchangés |
| `sortir/openagenda-batch-persister.js` | Conservation des résultats de tranches en cas d'erreur pour le suivi ; règles de persistance inchangées |
| `test-sortir-auto-ingest.js` | Adaptation de l'enveloppe de simulation au suivi par producteur ; conservation des tests historiques de lots et de curseur |
| `test-sortir-scheduler-reunion.js` | 17 tests d'intégration/régression sans réseau réel |
| `sortir/test-helpers/scheduler-client.js` | Client de base factice pour les tests de PK/CAS, de concurrence et de journalisation |
| `sortir/openagenda-reunion-scheduler-report.md` | Présent rapport |

Les changements V1 de validation/occurrences déjà présents avant cette intervention sont conservés. Les fichiers YouTube modifiés parallèlement sont hors périmètre et n'ont pas été touchés ici.

## Avant / après

Avant : trois agendas Senlis en un lot ; une exception de collecte/persistance interrompt la suite du cycle et empêche DATAtourisme d'être atteint. Le seul succès de Senlis sert de garde pour tout le cycle. Un verrou en mémoire protège seulement un processus.

Après : trois producteurs Senlis, puis les cinq producteurs Réunion, puis DATAtourisme si sa configuration existante l'active. Chaque producteur dispose de sa propre enveloppe de journalisation et de sa frontière d'erreur. Une erreur n'empêche pas les suivants de passer. Un passage complet récent ne dispense que sa source ; un producteur échoué est retenté aux prochains ticks de la fenêtre. Le statut du cycle est `completed`, `partial` ou `failed` selon les résultats réellement obtenus, et ne masque plus les statuts partiels renvoyés sans exception.

Les producteurs Senlis réutilisent `runOpenAgendaBatches`, appelé avec une source à la fois. La taille de lots configurable de cet utilitaire reste disponible à ses appelants directs ; elle ne regroupe plus plusieurs producteurs dans une même frontière d'erreur du scheduler.

## Heure et fréquence

Mécanisme inchangé : `.github/workflows/auto-collect.yml` → POST `/api/sortir-ingest-tick` → scheduler de `server.js`. Tick toutes les cinq minutes, cron GitHub UTC `*/5 * * * *`. Ingestion quotidienne à **04:00, Indian/Reunion (UTC+4)**, dans la fenêtre **04:00 inclus à 04:40 exclu**, soit **00:00–00:40 UTC**. Aucun second cron ajouté ; workflow, route serveur et fuseau non modifiés.

Le garde de 20 heures est conservé par source, appliqué exclusivement aux **runs enveloppes** de version `sortir-scheduler-source-v1`. Les runs de tranches ne certifient jamais un passage complet. À la première exécution du nouveau code, les anciens runs ne constituent pas ces nouveaux marqueurs : un premier passage idempotent constitue l'état de reprise de la nouvelle orchestration. Les ticks suivants ignorent les producteurs terminés ; seuls les échecs peuvent être retentés pendant la fenêtre quotidienne.

## Liste exacte des producteurs Réunion programmés dans le code

| Producteur | UID agenda | Clé de source inchangée depuis le pilote réel |
|---|---:|---|
| Bicentenaire de la Photographie 2026–2027 | 2568169 | `openagenda-2568169-json` |
| CINOR | 50316469 | `openagenda-50316469-json` |
| PUI VALIOTECH | 4740352 | `openagenda-4740352-json` |
| Innovons La Réunion | 40627992 | `openagenda-40627992-json` |
| GCS TESIS | 1059482 | `openagenda-1059482-json` |

La liste dérive directement de `PRODUCERS` du manifeste validé. Aucun autre agenda ajouté. Le connecteur réel `fetchOpenAgendaJsonEvents` est appelé avec le même instant, les créneaux en cours/futurs, l'emprise Réunion validée, les métadonnées de schéma, 200 événements maximum et pages de 50. Une troncature fait échouer le producteur avant toute écriture d'occurrence.

Les résultats passent par **`prepareItemForV1`**, puis **`createOpenAgendaBatchPersister`**, sans seconde logique éditoriale ou de déduplication. Batch de 100, cache compact, purge en fin de producteur y compris après échec, idempotence existante et absence de réconciliation de disparitions sur ces tranches. Les deux dossiers REVIEW et l'absence de code postal sont conservés. Les cinq nouveaux UID CINOR inconnus de la V1 restent refusés.

## Erreurs et suivi

Un run enveloppe et un source_run sont ouverts AVANT le fetch. Les erreurs de configuration, de lecture, de troncature, de persistance et de journalisation sont visibles et rattachées à la source. Une source terminée n'est pas invalidée par l'erreur d'une autre. Même après une erreur de mise à jour du journal source, la fermeture du journal d'ingestion est tentée séparément. Une panne d'écriture des journaux est loguée ; aucun succès n'est inventé.

Les logs JSON `[sortir-auto-ingest] producteur` indiquent source, début, fin, statut, erreurs, événements collectés/retenus, occurrences collectées/retenues pour la V1 et activités créées/mises à jour. Les deux derniers compteurs observent les primitives du store, en distinguant les créations de leurs bascules finales. Les résultats des tranches déjà traitées restent disponibles après erreur. Les compteurs dont la collecte n'a pas abouti restent inconnus (`null`) plutôt que d'être présentés comme une collecte vide.

Les tables existantes gardent les runs enveloppes, les runs de tranches, les compteurs de validation, les erreurs et les collections liées aux activités/provenances. Les détails supplémentaires de métriques sont dans les logs structurés, sans ajouter de colonne. Le résumé de cycle reflète également les erreurs de suivi et de libération du verrou. Un callback de suivi en échec n'invalide pas le succès métier déjà journalisé d'une source.

## Concurrence et limites du verrou

Le verrou local `inFlight` reste posé avant tout await, et est libéré aussi après un échec de construction du client ou de préparation.

Le verrou partagé utilise **une ligne technique existante dans `sortir_ingestion_runs`**, ID `be127190-19a4-4f50-b615-7a9a78b8ff14`, version `sortir-scheduler-lock-v1`. Première acquisition par INSERT protégé par la PK ; acquisitions suivantes par UPDATE conditionnel atomique `completed → running`. Une seule instance gagne. La ligne technique n'a aucune provenance ni source et ne doit pas être interprétée comme une collecte ; aucun ajout de schéma nécessaire. La libération remet `completed`. Aucun effacement de journal n'est effectué.

Le scheduler refuse aussi de démarrer si un autre ingestion_run ou source_run est déjà running. **Il n'existe pas de vol automatique d'un verrou running** : un arrêt brutal ou une fermeture de journal restée indéterminée exige un contrôle opérateur, puis une remise en état explicite après confirmation qu'aucun processus ne travaille encore. Ce choix évite un chevauchement après expiration arbitraire.

Le verrou protège les instances utilisant ce scheduler. Les scripts manuels historiques ne l'acquièrent pas : le contrôle de départ détecte un script déjà en cours, mais un script lancé après ce contrôle n'est pas couvert. Leur lancement doit rester coordonné avec le cycle automatique. Le moteur manuel DATAtourisme n'a pas été modifié pour élargir le protocole de verrouillage.

## Interaction DATAtourisme

La fonction **`runDatatourismeChunks` est strictement identique à HEAD**, comparaison de texte et SHA-256 :

`0dea5a4c87acab966bd2dce7a4175e7c0de8300a76bb1618602940514aa26d8d`

Clé logique, connecteur, plafonds, chunking, règle d'avancement du curseur et règles de déduplication inchangés. Aucun changement du checkpoint national, de migration ou de SQL. L'enveloppe additionnelle constate le résultat ; elle n'ajoute aucun reset de curseur. Un résultat DATAtourisme partiel ne devient plus un succès global, et ne fait pas rejouer les producteurs OpenAgenda déjà terminés. Une exception OpenAgenda n'empêche plus d'atteindre l'étape DATAtourisme configurée.

## Tests et résultats

Tous les tests sont exécutés localement avec un préchargement qui interdit le réseau réel. Dans les tests d'intégration, les seules réponses HTTP autorisées sont construites en mémoire à partir du corpus archivé et contrôlées par hôte/URL/méthode. Aucun client Supabase réel ni endpoint de cron appelé.

- **Suite complète : 42 scripts, 0 échec**, incluant les tests Sortir existants, le scheduler historique et le nouveau scheduler Réunion.
- **Suite historique du scheduler : 22 tests réussis, 0 échec**.
- **Nouveaux tests scheduler : 17 réussis, 0 échec, 0 ignoré**.
- Vérification finale ciblée scheduler + V1 : **34 tests réussis, 0 échec, 0 ignoré** ; tests historiques relancés après les dernières modifications de journalisation, toujours 22/22.
- `git diff --check` valide.

Les 17 nouveaux tests couvrent : cinq producteurs exacts sans extension ; vrai connecteur/filtre V1/persister ; rejet des cinq nouveaux UID CINOR ; fixture et rejeu avec **536 activités, 536 provenances, 1 079 IDs, 227 active et 309 review** ; **4 cartes Explorer** sur le vrai moteur avec base factice ; code postal manquant conservé ; erreurs de fetch et de configuration isolées/journalisées ; continuité vers DATAtourisme ; reprise source indépendante de Senlis ; panne en deuxième tranche puis reprise sans doublon ; troncature sans écriture d'occurrence ; exclusion PK/CAS de deux clients ; verrou running non repris ; ingestion manuelle déjà running ; source_run running isolé ; libération après erreur de préparation ; statuts partiels/cursor DT ; erreurs de registre, de fermeture des journaux, de callback et de libération ; double tick local ; compteurs de créations et mises à jour.

Ces nombres sont **mesurés sur harnais**, pas une nouvelle mesure de production. Les vérifications réelles de production restent celles du rapport d'ingestion précédent. Le verrou et la jointure de reprise sont testés sur client factice ; aucune validation active sur PostgreSQL de production n'a été effectuée à cette étape.

Preuves locales : `/tmp/oa-reunion-scheduler-audit/suite/result.json`, `final-targeted.log`, `final-existing-tests.log`, `new-tests.log`, `final-proof.json` et les logs par script dans `suite/`.

## État Git à la fin

Les sorties suivantes décrivent tout le dépôt, y compris les travaux V1 antérieurs et les changements YouTube parallèles. Les fichiers non suivis n'entrent pas dans `git diff --stat`.

`git diff --stat` :

```
 sortir-auto-ingest.js                | 212 ++++++++++++++----------
 sortir/activity-deduplication.js     |  10 ++
 sortir/connectors/openagenda-json.js | 165 ++++++++++++++-----
 sortir/supabase-persistence.js       |   4 +-
 sortir/test-openagenda-json.js       |  10 +-
 sortir/test-supabase-persistence.js  |  31 +---
 test-sortir-auto-ingest.js           |  21 ++-
 youtube-chaines-certamen.json        | 302 ++++++++++++++++++++++++++++++++++-
 youtube-chaines.json                 | 302 ++++++++++++++++++++++++++++++++++-
 9 files changed, 886 insertions(+), 171 deletions(-)
```

`git status --short` :

```
 M sortir-auto-ingest.js
 M sortir/activity-deduplication.js
 M sortir/connectors/openagenda-json.js
 M sortir/supabase-persistence.js
 M sortir/test-openagenda-json.js
 M sortir/test-supabase-persistence.js
 M test-sortir-auto-ingest.js
 M youtube-chaines-certamen.json
 M youtube-chaines.json
?? sortir/fixtures/openagenda-reunion-v1-archived.json
?? sortir/openagenda-batch-persister.js
?? sortir/openagenda-reunion-daily.js
?? sortir/openagenda-reunion-scheduler-report.md
?? sortir/openagenda-reunion-v1-production-report.md
?? sortir/openagenda-reunion-v1-report.md
?? sortir/openagenda-reunion-v1.js
?? sortir/scheduler-state.js
?? sortir/test-helpers/
?? sortir/test-openagenda-reunion-v1.js
?? sortir/test-openagenda-v1.js
?? test-sortir-scheduler-reunion.js
?? youtube-ina-sources.md
```

**PRÊT POUR COMMIT/PUSH : OUI.**
