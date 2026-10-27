# DATAtourisme — audit performance (lecture seule)

27 octobre 2026. Aucune optimisation implémentée, aucune écriture Supabase métier, aucune
migration. Sources : journal exhaustif des 275 462 requêtes du scan national
(`requests.jsonl`), 548 tranches (`chunks.jsonl`), 53 lots, 594 pages API, mesures
read-only en direct et prototypes hors ligne sur pages et snapshot réels.

## 1. Baseline Git

Commit `eb10a87` — `fix(sortir): stabilize DATAtourisme national ingestion` (47 fichiers,
parent `0d17e89`). Non commités, non touchés : `medias.json`, `medias-certamen.json`,
`youtube-chaines.json`, `youtube-chaines-certamen.json`. Suite : 616 vérifications / 36
scripts, 0 échec.

## 2. Coût mesuré du scan national

| Mesure | Valeur |
|---|---|
| Requêtes Supabase | 275 462 (dont 13 310 lectures, 262 152 écritures/RPC) |
| Temps réseau cumulé | 23,85 h (requêtes strictement séquentielles, ~280 ms chacune) |
| Temps de persistance (tranches) | 21,8 h pour 67 308 occurrences = 1,17 s / occurrence |
| Volume lu | ~4,9 Go (dont 4,7 Go `GET sortir_activities`) |
| API DATAtourisme | 594 pages, 0,84 s/page en moyenne (p95 1,85 s), 7,2 min au total |
| Lot NEW de ~1 000 POI | 26,5 min en moyenne (8–35 min), ~5 000 requêtes |
| Lot UNCHANGED de ~1 000 POI | 1,9 min, 128 requêtes, dont 124 dues aux contrôles du pilote |
| Pic RSS | 1 268 Mio (pilote compris) |

## 3. Ventilation des requêtes

| Opération | Table/RPC | Lectures | Écritures | Par occurrence NEW | Temps cumulé |
|---|---|---|---|---|---|
| Création staging | POST `sortir_activities` | | 64 013 | 1 | 301 min |
| Provenance | POST `sortir_provenances` | | 64 466 | 1 | 303 min |
| IDs externes | POST `sortir_external_ids` | | 64 466 | 1 | 300 min |
| Bascule review/active ou fusion MATCH | PATCH `sortir_activities` | | 64 467 | 1 | 302 min |
| Candidats (fenêtres de jours) | GET `sortir_activities` (candidate) | 1 242 | | 0,02 | 28,5 min / 1,03 Go |
| Préchargement + rafraîchissement du cache | GET `sortir_activities` | 2 438 | | 0,04 | 32 min / 0,76 Go |
| Contrôles du pilote avant ACK | GET `sortir_activities` | 4 008 | | — | 68,5 min / 2,7 Go |
| Provenances connues | GET `sortir_provenances` | 1 637 | | 0,02 | 24 min |
| Décisions REVIEW (réactivation/couverture) | GET `sortir_dedup_decisions` | 2 158 | | — | 12 min |
| Réconciliation par POI | RPC `load_datatourisme_poi_provenances` | 649 | | — | 12 min |
| Compteur final par tranche | HEAD `sortir_activities` (count exact) | 548 | | 1/tranche | 4,2 min |
| Source par tranche (renvoie le checkpoint JSON) | POST `sortir_sources` | | 551 | 1/tranche | 4,3 min / 23,5 Mo |
| Runs par tranche | `ingestion_runs` / `source_runs` | | 2 745 | 5/tranche | 13 min |
| Historique | POST `sortir_collection_items` (groupé) | | 551 | 1/tranche | 7,3 min |
| Décisions | POST `sortir_dedup_decisions` | | 610 | | 2,9 min |
| Empreintes | POST `sortir_datatourisme_poi_states` (groupé) | | 106 | | 3,4 min |
| Checkpoint | observe / finish / finalize / reopen | 16 | 126 | 1/lot | ~1,5 min |

**93,4 % des requêtes** sont les quatre écritures unitaires par occurrence nouvelle.

## 4. Ventilation des écritures

- Le N+1 dominant vient de `persistSortirIngestionUnlocked` : une occurrence nouvelle coûte
  4 allers-retours (staging → provenance → IDs → bascule), plus 1 décision par revue. Sur un
  lot de 1 200 occurrences, cela fait ~4 800 écritures.
- Chaque activité nouvelle est écrite deux fois (INSERT staging puis PATCH de bascule). C'est
  voulu pour l'atomicité, mais pourrait se faire par tranche au lieu de ligne par ligne.
- Coût fixe par appel `persistSortirIngestion`, soit par tranche de 100 POI : `ensureSource`,
  2 runs créés puis mis à jour, `countFinalActivities`, collection items. Environ 7 requêtes
  × 551.
- Chemin CHANGED (simulation) : `updateProvenance` + `upsertExternalIds` + `updateActivity` +
  `insertCollectionItem` **unitaires**, soit 4 par occurrence modifiée.
- Fusion MATCH (453 sur le scan) : PATCH de la ligne complète, même sans changement métier
  (`updated_at`/`last_seen_at` régénérés).
- Empreintes, collection items et touches de provenances inchangées sont déjà groupés.

## 5. Profil temps

| Étape | Mesure |
|---|---|
| Téléchargement API | 0,84 s/page, soit ~8,5 s par lot de 10 pages |
| Normalisation + sélection + KEEP/DENY | 0,22 s pour 1 000 POI (prototype, CPU) |
| Recherche de candidats + dédoublonnage CPU | < 1 s pour 1 000 POI (prototype, MemoryStore compris) |
| Lectures Supabase du pipeline | ~1,8 h sur le scan (candidats, préchargements, réconciliation) |
| Écritures Supabase | ~20,5 h sur le scan |
| Réconciliation + empreintes | ~15 min sur le scan |
| Contrôles du pilote (couverture + signatures) | 76 min sur le scan |
| Précontrôle global | 9 min 09 s par exécution (voir §7) |

La persistance est entièrement limitée par la latence réseau : 21,8 h de tranches pour 22,3 h
d'allers-retours. Le CPU n'est pas le problème. La durée des tranches est passée de 126 s à
165 s au fil du scan : plus de candidats à charger et une latence Supabase variable.

## 6. Profil mémoire / cache

- `TemporalCandidateCache` est une instance unique par run, partagée par tous les lots.
  - Clé : id d'activité.
  - Valeur : la ligne complète compactée (description comprise), plus les provenances sans
    payload, les IDs externes et un index par jour (tokens de titre ×2 clés JSON, identités,
    URL).
  - Éviction : aucune. Seule la réconciliation invalide des jours entiers. Plafond dur à
    100 000 lignes / 256 Mo, au-delà duquel le pipeline s'arrête.
- Croissance : 0 → 73 495 lignes et 171 Mo de JSON sur le scan. Les POI arrivent dans un
  ordre de dates aléatoire, donc les jours couverts s'accumulent jusqu'à couvrir presque toute
  la table (786 jours).
- Coût mesuré hors ligne : ~2,3 Ko de JSON par ligne, 2,2 à 5,1 Ko de tas par ligne. Pour
  77 000 lignes, 160 à 380 Mio de tas selon le partage des chaînes. Part du JSON :
  description 41 Mo, provenances 35, IDs 22, autres colonnes 37.
- RSS observé : 333 → 1 119 Mio pendant la tranche, avec des retombées aux redémarrages
  (399). La part pilote non transposable au scheduler comprend le snapshot `before-rows`
  gardé en mémoire (~300 Mio) et le précontrôle exécuté dans le processus au redémarrage.
- `refresh()` relit après chaque tranche, avec embeds complets, toutes les lignes touchées :
  2 438 requêtes et 0,76 Go. C'est une lecture « autoritaire » prudente, mais redondante avec
  les représentations renvoyées par les écritures.
- Une éviction par jour ne changerait pas la sémantique : un jour évincé est relu depuis la
  base (la source de vérité) et l'ordre des candidats est un tri par id, indépendant de
  l'insertion. Le compromis est davantage de relectures en scan initial ; c'est négligeable
  en quotidien.

## 7. Coût du précontrôle global

Mesure en direct (lecture seule) : **549 s**, 313 lectures, 367 Mio de RSS, 13,5 s de CPU,
pour 77 495 provenances, 77 221 activités et 715 décisions. Il grossit linéairement avec la
table. Le lancer avant chaque lot quotidien est exclu.

Niveaux proposés :

1. **Par lot, obligatoire et déjà présent** : couverture des POI persistés avant empreinte,
   garde de signature avant INSERT, quarantaine complète.
2. **Incrémental par lot (à ajouter)** : audit de signature et de quarantaine restreint aux
   activités touchées et à leurs voisines de même début. Mesuré à ~35 requêtes par lot NEW.
3. **Global périodique** : en fin de scan ou une fois par semaine, et avant toute reprise
   après incident.

## 8. Scénario NEW (cold, 1 000 POI)

- Mesuré : ~5 000 requêtes, ~4 840 écritures, 26,5 min en moyenne.
- Simulé sur de vraies pages : 4 960 requêtes, 23 min de réseau estimé à 280 ms, < 1,2 s de
  CPU.
- RAM : le cache croît de ~1 250 lignes par lot.

## 9. Scénario UNCHANGED (warm, 1 000 POI)

- Mesuré en réel (2 lots rejoués après coupure) : **4 requêtes pipeline** (chargement des
  états ×2, observe, finish), ~3 s de réseau, aucune persistance, aucune lecture de
  candidats. Les 124 autres requêtes (110 s, 73 Mo) venaient des contrôles du pilote.
- Simulé : 4 requêtes, 2 écritures, 0,2 s de CPU.
- Passage national quotidien entièrement inchangé : ~250 requêtes Supabase plus 630 pages
  API séquentielles (curseur), soit **~9–10 min**, dominés par l'API.

## 10. Scénario MIXED (5 % CHANGED, 2 % NEW, 93 % UNCHANGED, sur 1 020 POI)

- Simulé : 302 requêtes, 288 écritures, ~1,4 min de réseau estimé.
- À l'échelle nationale : ~19 000 requêtes, **~1,5 h** dans l'état actuel. Le coût vient des
  écritures unitaires des chemins CHANGED et NEW.
- Le taux réel de changements quotidiens est inconnu ; il devra être mesuré au premier
  passage quotidien. Le catalogue a perdu 2 700 fiches en 5 jours.

## 11. Principaux N+1

1. 4 écritures unitaires par occurrence nouvelle (256 000 requêtes, 93 %).
2. Chemin CHANGED : 4 écritures unitaires par occurrence modifiée, dont un collection item
   individuel.
3. Coût fixe par tranche de 100 POI au lieu d'une fois par lot : source, runs, compteur
   final (~3 800 requêtes, ~26 min).
4. `refresh()` du cache après chaque tranche (2 438 GET, 0,76 Go).
5. `getActivitiesBatch` embarque `provenances(*)`, `source_payload` compris, pour chaque
   préchargement et chaque contrôle.
6. Lecture des décisions pour chaque réactivation (rare) et pour la couverture review
   (2 158 GET, petits).

## 12. Optimisations classées

| Prio | Problème | Preuve | Modification | Gain attendu | Risque | Tests | Reprise/idempotence | RAM | Supabase |
|---|---|---|---|---|---|---|---|---|---|
| **P0** | 4 écritures unitaires par occurrence | 256 000 req, ~20 h | Écritures groupées par tranche : INSERT staging en masse (ids générés côté client), décisions groupées, provenances groupées, IDs en upsert groupé (sur la clé primaire), bascule `PATCH in.(ids)` par 100. Repli unitaire existant si conflit 23505 | ~×25 sur les requêtes du chemin NEW ; lot cold de ~26 min à ~1–2 min | Moyen : point de validation, mapping ids, conflits | Mêmes résultats avant/après sur les fixtures (Silver Friday, Singulières, Anne, Noël, Lanvénégen) + tests D/S d'interruption à chaque étape groupée | Inchangées si l'ordre staging → décisions → provenances → IDs → bascule est conservé ; un staging perdu reste `stale` | Neutre | −90 % de requêtes |
| **P0** | Coût fixe par tranche | 3 800 req | Un seul run/source par lot ; source mise en cache ; `countFinalActivities` une fois par run | −3 800 req, −25 min sur le scan | Faible | Compteurs de runs, rapports | Aucun | Neutre | −23 Mo de lecture du checkpoint |
| **P0** | Contrôles du pilote en quotidien | 124 req et 110 s par lot UNCHANGED | Ne pas re-vérifier chaque jour la couverture des POI UNCHANGED (empreinte déjà validée) ; contrôle incrémental limité aux POI persistés | Lot quotidien de 2 min à ~10 s | Faible (contrôle déplacé, pas supprimé) | Test « UNCHANGED = 0 lecture métier » ; audit global périodique | Aucun | Baisse | −95 % des lectures quotidiennes |
| **P1** | Cache candidats sans borne | 73 000 lignes, jusqu'à 380 Mio | Éviction par jour (LRU borné) ou cache par lot ; relecture depuis la base si besoin | RAM bornée < 300 Mio en cold, minime en quotidien | Faible à moyen (ordre des candidats déjà indépendant de l'insertion) | Équivalence stricte des décisions sur un rejeu de pages réelles avec et sans éviction | Aucun | Forte baisse | + relectures de candidats en cold uniquement |
| **P1** | `refresh()` après chaque tranche | 2 438 GET, 0,76 Go | Mettre à jour le cache depuis les représentations renvoyées par les écritures | −2 400 GET | Moyen (fraîcheur de `last_seen`/provenances) | Équivalence des fusions intra-run | Aucun | Neutre | −0,76 Go |
| **P1** | Écritures unitaires du chemin CHANGED | 4 req par occurrence modifiée | Upsert groupé des provenances, activités et IDs ; collection items groupés | MIXED : de ~1,5 h à ~15–20 min sur le national | Moyen | Équivalence des fusions et des rejeux | À préserver par tranche | Neutre | −80 % en quotidien |
| **P2** | Embeds lourds | `provenances(*)` avec payload | Select ciblé dans `getActivitiesBatch` (préchargement/refresh) | −1 à 2 Go de lecture sur un scan | Faible | Comparaison des lignes utilisées | Aucun | Baisse | Egress |
| **P2** | Précontrôle global | 9 min | Version incrémentale (activités touchées et voisines) + global hebdomadaire | Quotidien sans contrôle national | Faible | Mêmes alertes sur les cas connus | — | — | −313 lectures par exécution |
| **P2** | API séquentielle | 630 pages × 0,84 s | Garder le curseur pour le scan d'absences ; étudier un filtre de dernière mise à jour pour les jours intermédiaires | ~9 min → ? | Moyen (sémantique des absences) | — | — | — | — |
| **P3** | CPU dédoublonnage/normalisation | < 2 s par lot | Rien | — | — | — | — | — | — |
| **P3** | RPC transactionnelle par tranche | — | Atomicité SQL réelle, mais migration nécessaire | Requêtes encore ÷3 | Migration | — | Meilleure | — | — |

## 13. Estimation des gains (ordres de grandeur, à confirmer par prototype mesuré)

| Scénario | Aujourd'hui | Après P0 | Après P0+P1 |
|---|---|---|---|
| Lot cold 1 000 POI | ~5 000 req, 26 min | ~150–250 req, 1–2 min | idem, RAM bornée |
| Scan national cold | 276 000 req, ~25 h | ~12 000 req, ~1,5 h | ~10 000 req, ~1–1,5 h, < 500 Mio |
| Quotidien UNCHANGED (national) | ~250 req pipeline + contrôles pilote, ~2 h | ~250 req, ~10 min (API) | idem |
| Quotidien MIXED (5 %/2 %) | ~19 000 req, ~1,5 h | ~8 000 req, ~45 min | ~2 000 req, ~15–20 min |

- Un facteur ×10 sur les requêtes est crédible pour le cold et le MIXED.
- Pour l'UNCHANGED, le pipeline est déjà minimal ; le gain vient du retrait des contrôles du
  pilote.
- « Quelques minutes » par jour n'est atteignable qu'à ~10 min, à cause des 630 pages de
  l'API, sauf si un mode incrémental API est validé.
- Une mémoire bornée sous 1 Gio est réaliste : le cache borné vaut quelques centaines de Mio
  et le pilote ne tourne pas en production.

## 14. Ordre d'implémentation recommandé

1. Harnais de non-régression : rejouer N lots réels archivés dans un MemoryStore et comparer
   des empreintes canoniques complètes (activités, provenances, IDs, décisions, statuts)
   avant/après chaque optimisation.
2. P0 coût fixe par tranche (faible risque, rapide).
3. P0 écritures groupées du chemin NEW, avec repli unitaire et tests d'interruption étape par
   étape.
4. P0 contrôles quotidiens incrémentaux à la place des contrôles du pilote.
5. P1 cache borné, puis suppression de `refresh()`.
6. P1 chemin CHANGED groupé.
7. P2 embeds ciblés et précontrôle incrémental, puis mesure réelle d'un passage quotidien en
   lecture seule avant le scheduler.

## 15. Risques et régressions à tester

- Équivalence stricte MATCH/DISTINCT/REVIEW, des quarantaines et de la multisource sur les
  fixtures archivées et sur au moins 10 lots réels rejoués.
- Atomicité groupée : interruption après chaque requête groupée (staging, décisions,
  provenances, IDs, bascule, historique), réponse perdue, rejeu et doublons, conflit 23505
  partiel dans un lot.
- Ordre des candidats intra-tranche : une occurrence doit voir les activités créées plus tôt
  dans la même tranche avant l'écriture groupée. C'est le point délicat du groupage : il faut
  décider en mémoire puis écrire en lot, sans relecture.
- Fraîcheur du cache sans `refresh()` (`last_seen`, provenances).
- Reprise de checkpoint, horloges distinctes et dérive source inchangées.
- Taille des corps POST groupés et budgets d'URL des filtres `in.(…)` (déjà bornés à 100).
