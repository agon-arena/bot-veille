# Validation DATAtourisme — identité et qualité éditoriale

## Correctif

Dans `supabase-persistence.js`, le choix d’un MATCH peut désormais utiliser une validation NEEDS_REVIEW uniquement si elle ne contient aucune erreur, au moins un avertissement et exclusivement `organizer_name_missing`. Les codes inconnus, confiance insuffisante et autres avertissements restent bloquants. Le dédoublonneur doit toujours avoir conclu MATCH ; aucun critère temporel ou spatial n’est assoupli. Les diagnostics NEEDS_REVIEW sont conservés dans les collection items et le statut de l’activité gagnante est conservé (une review n’est pas promue active).

Cas archivé : « Le vol du cœur d’Anne de Bretagne », POI `1179c639-b62b-3efd-9dc2-8148cb2f1f40`, activité `5807d6cf-687d-4032-b739-d8a5c476cab4`, 1 novembre 2026 11–19h Europe/Paris, soit 10–18h UTC. Titre, description, lieu, coordonnées, intervalle identiques ; même URL de contact, noms absents ; aucun autre avertissement ou contradiction.

## Régression

560 vérifications / 34 scripts verts ; `git diff --check` propre. Les tests couvrent la persistance avec/sans nom, les organisateurs contradictoires, les horaires distincts et lieux contradictoires avec nom absent, le cas archivé et son rejeu, Singulières et les multi-sessions, ainsi que le maintien du blocage pour confiance faible.

## Pages 41–50 : démontré en réel

996 calculables, 4 invalides, 1 266 occurrences couvertes. Résultat réel strictement égal au dry-run : +782 activités, +784 provenances, +2 352 external IDs ; deux MATCH dont Anne de Bretagne sans nouvelle activité. Les 482 provenances déjà persistées ont gardé leurs rattachements. Checkpoint acquitté page 50.

La continuation pages 51–60 a ensuite persisté 1 316 occurrences (996 calculables, 4 invalides) mais a rencontré un timeout GET pendant la vérification de couverture, avant validation des empreintes. Arrêt sûr, sans finalisation nationale. La reprise complète Oct24 a duré 59 min 39 s, dont 57 min 08 s de persistance, pic RSS 370,8 Mio ; 8 870 appels Supabase (299 lectures, 8 571 écritures/RPC), 10 appels DATAtourisme / 4,42 s de collecte.

Audit réel après cet arrêt : activités 7 788→9 886, provenances 8 043→10 143, IDs 24 080→30 380, états POI 5 026→6 026. Aucun doublon, orphelin ou run bloqué ; 96 multisources préservées ; autres sources inchangées ; seule exception Lever du soleil inchangée. Aucune empreinte prématurée pour le lot non acquitté.

## Reprise du 25 octobre

Snapshot strictement en lecture seule, précontrôle sain sauf exception réservée. Dry-run pages 51–60 : 1 316 couvertes, zéro création/retrait métier ; rejeu simulé 996 UNCHANGED / 4 invalides sans callback de persistance. Curseur page 61 contrôlé, total catalogue stable à 62 940.

Réouverture verrouillée du même scan `384c3c2f-649f-482f-a3dd-9431e6e163fc`, JSON complet attendu comparé ; seule transition failed→running. Horloge pending conservée `2026-10-24T14:02:12.407Z`, nouvelles pages `2026-10-25T04:25:51.603Z`.

Pages 51–60 réellement rejouées et acquittées : zéro nouvelle activité/provenance/external ID ; 996 empreintes validées après couverture. Les 1 316 provenances et leurs liens conservés. Compteurs métier après acquittement inchangés à 9 886 / 10 143 / 30 380 ; zéro orphelin/doublon/run bloqué, 96 multisources.

## Verdict final B — contradiction géographique à arbitrer

Les pages 61–90 ont été acquittées après couverture complète. Arrêt avant INSERT au POI de position nationale 9 407 (page 95, index zéro 6), dans le pending 91–100. Aucun contournement de la protection géographique, aucune réparation de ce cas.

« Noël au château » : nouvelle fiche `25b6bd21-f624-3fc9-a873-8cc819ae6161`, producteur `FMANOR014V54P4CE`, face à la fiche `0e898107-1fb2-3a07-8cc1-f1a7b4724159`, producteur `FMANOR014V567ZFM`, activité existante `b92c639c-5b42-49ae-bf87-4007bbb7a777`.

Titre, description, adresse Avenue du château / 14270 Mézidon Vallée d’Auge, URL de contact et intervalle identiques : 19 décembre 2026 14:00 → 31 décembre 2026 19:00 Europe/Paris, soit 13:00 → 18:00 UTC. Mais coordonnées source divergentes : ancienne (49.0780719, -0.0914689), nouvelle (49.07323, -0.07877), distance calculée 1 070 m. Les données brutes confirment cette différence ; le dédoublonneur renvoie `datatourisme_inter_poi_contradiction`, donc REVIEW. L’absence de nom organisateur n’est plus le motif de blocage : le MATCH n’est pas démontré selon les règles géographiques conservées. Les images diffèrent également (visuel 2025 / 2026), sans être la cause du REVIEW. Il faut résoudre la contradiction géographique avant de décider d’un rattachement ; aucune conclusion automatique sur le bon point GPS.

Activité existante strictement inchangée ; aucune nouvelle provenance pour la fiche bloquante ; empreinte de cette fiche NULL. Le garde-fou a empêché le doublon avant création. Le dernier source-run est fermé en partial, aucun run running.

### État durable et couverture

- Checkpoint `failed`, 90 pages / 9 000 POI acquittés, 55 invalides acquittés ; catalogue annoncé 62 940.
- Pages 91–100 archivées, 1 000 POI pending, horloge `2026-10-25T04:25:51.603Z` ; 991 calculables, 9 invalides, 1 246 occurrences sélectionnées.
- Pending : 558 nouvelles activités/provenances et 1 674 IDs déjà persistés ; 688 occurrences sélectionnées non encore couvertes. Aucune des 991 empreintes n’est validée. Pas d’acquittement du lot ni de finalisation nationale.
- 8 971 empreintes non nulles en base ; 0 dans le pending courant.
- Audit transversal des archives acquittées pages 11–90 : 7 950 POI calculables, 10 179 occurrences, aucune perte de couverture. L’audit global des 12 101 provenances DATAtourisme actives ne relève que l’exception Lever du soleil déjà réservée.
- Zéro doublon de clés provenance/external ID, zéro orphelin, zéro activité active/review sans soutien, zéro groupe de signatures fonctionnelles dupliquées ; aucun run running.
- 96 activités multisources préservées, aucun changement d’intervalle ni perte de soutien ; provenances/IDs des autres sources inchangés ; exception Lever du soleil strictement inchangée.

### Mesures cumulées de cette étape de correction éditoriale (deux lancements)

60 pages distinctes reçues (41–100), dont 50 acquittées (41–90). Avec le rejeu 51–60, les compteurs d’exécution portent sur 7 000 réceptions. 50 appels DATAtourisme, 18,36 s de collecte HTTP. 2 h 21 min 15 s de durée cumulée des deux processus, dont 2 h 14 min 46 s de persistance. Audits/dry-runs préparatoires séparés, hors ces durées.

26 429 requêtes Supabase du runner : 927 lectures, 25 502 écritures/RPC ; les snapshots et audits indépendants s’ajoutent séparément. 8 036 occurrences dans les sous-lots achevés, plus 1 écriture d’occurrence du sous-lot interrompu avant flush d’historique ; ce compteur inclut la réutilisation des 482 provenances initiales et le rejeu de 1 316 occurrences, et ne représente pas autant de créations.

Pages 41–90 : 4 971 NEW calculables, 29 invalides, 0 CHANGED / 0 UNCHANGED au niveau empreintes ; 6 163 occurrences sélectionnées, toutes couvertes. Les lignes déjà persistées mais sans empreinte validée sont normalement classées NEW puis réutilisées. Quatre MATCH persistés au total ; créations : 3 073 active et 3 162 review. Aucun retrait ni stale dans cette étape. Le rejeu simulé après validation reste UNCHANGED ; le rejeu réel du pending 51–60 a créé zéro ligne métier.

Dernier lancement seul : 5 000 réceptions (1 000 archivées + 4 000 nouvelles), 40 appels API, 17 559 requêtes Supabase (628 lectures / 16 931 écritures-RPC), 1 h 21 min 36 s, pic RSS 422,3 Mio ; cache maximal 12 184 lignes / 27,6 Mio, 8 029 candidats chargés. Aucune croissance mémoire incontrôlée observée. Le coût dominant reste la persistance séquentielle des nouveaux POI ; aucune optimisation structurelle n’a été entreprise.

| Compteur | Avant correction/réel | Après arrêt final | Delta |
|---|---:|---:|---:|
| activités | 7 788 | 14 023 | +6 235 |
| provenances | 8 043 | 14 282 | +6 239 |
| external IDs | 24 080 | 42 797 | +18 717 |
| états POI | 5 026 | 10 026 | +5 000 |
| collection items | 11 640 | 19 676 | +8 036 |

Statuts finaux : active 6 096, review 6 188, stale 1 735, merged 4. Stale et merged inchangés.

### Validation / Git / suite

Suite complète relancée après l’arrêt : 560 vérifications / 34 scripts, zéro échec. `git diff --check` propre. Les modifications propres à ce correctif sont dans `sortir/supabase-persistence.js`, `sortir/test-datatourisme-inter-poi.js`, `sortir/fixtures/datatourisme-editorial-match-archived.json` et ce rapport ; le travail DATAtourisme antérieur est conservé.

Branche main. HEAD observé au début `75299c3`, puis `0d17e89` à la fin : commit YouTube indépendant `fix: recover intermittent YouTube feed failures`, limité à veille-mixte.js, youtube-collection.js et son test. Aucun commit/push effectué par ce travail DATAtourisme. Aucun fichier de ce commit tiers modifié ici.

Avant une reprise : arbitrage de la divergence GPS du cas Noël au château, puis précontrôle/dry-run du pending avec son horloge conservée et réouverture verrouillée. Le national n’est pas terminé ; aucune préparation de branchement scheduler ni deuxième scan national.

Preuves supplémentaires : `latest-stopped-rows.json`, `integrity-latest-stopped.json`, `latest-stop-proof.json`, `anne-real-proof.json` dans `/private/tmp/dt-editorial-match-validation/` ; `blocked-creation.json`, `geographic-conflict-evidence.json`, archives 91–100, journaux et métriques dans `/private/tmp/dt-editorial-match-retry-20261025/national/`.

Preuves : `/private/tmp/dt-editorial-match-validation/` et `/private/tmp/dt-editorial-match-retry-20261025/` (snapshots, dry-runs, archives, contrôles, journaux, checkpoints et métriques).

Aucun scheduler/OpenAgenda/plafond modifié ; aucun commit/push ; aucune réparation générale ni optimisation structurelle.
