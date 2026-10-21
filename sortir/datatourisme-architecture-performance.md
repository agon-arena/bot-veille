# Optimisation nationale — validation hors ligne du 21 octobre 2026

Ce document remplace les coûts par page de `datatourisme-poi-state.md` pour le nouveau chemin **opt-in**. L'ancien runner et son oracle de tests sont conservés. Aucun scheduler ne l'appelle. Migration proposée uniquement, aucune écriture distante ni ingestion réelle.

## Checkpoint

`runNationalScanBatched` accepte 500 ou 1 000 POI. Le transport conserve ses pages de 100 ; un checkpoint contient au maximum 5 ou 10 pages entières, y compris lorsque des pages sont petites. Valeur recommandée : 1 000.

| Catalogue de 61 289 POI / 613 pages | Ancien | 500 | 1 000 |
| --- | ---: | ---: | ---: |
| Début + observation/acquittement + finalisation | 1 228 RPC | 248 RPC | 126 RPC |
| Pages maximales rejouées après crash | pas de reprise automatique | 5 | 10 |
| POI maximaux rejoués après crash | — | 500 | 1 000 |

126 = 1 début + 62 observations + 62 acquittements + 1 finalisation. Une reprise ajoute une lecture RPC du checkpoint. Aucune observation individuelle. Les observations mettent à jour les 61 289 lignes d'état : le nombre réduit de RPC ne supprime pas ce travail SQL.

Le JSON existant sur `sortir_sources` reçoit `batch_size`, `initial_url`, les compteurs d'erreurs et le dernier URL acquitté. Le lot `pending` contient ses UUID ordonnés (environ 39 Ko pour 1 000), ses URL, son total et son nombre de pages, jamais les fiches brutes. Pas de journal ni table supplémentaire.

Protocole :

1. Télécharger et vérifier au maximum dix pages : périmètre national fixe, UUID uniques, total positif stable, liens et compteurs cohérents.
2. Observer les UUID bruts en une transaction **avant** conversion. Les invalides annulent donc aussi toute absence. La RPC refuse les UUID d'un lot déjà acquitté. Un pending rejoué doit avoir exactement les mêmes UUID, ordre, URL et compteurs.
3. Calculer, persister et réconcilier. Chaque UUID doit être comptabilisé en succès ou erreur de conversion isolée ; chaque NEW/CHANGED doit être effectivement validé.
4. Acquitter le lot seulement ensuite. L'acquittement incrémente les pages réelles, conserve les erreurs et avance le curseur ; le dernier total exact seul permet `complete`.
5. Appeler explicitement la finalisation atomique existante : deux scans complets absents restent nécessaires.

En cas d'erreur, le nouveau runner laisse le checkpoint `running`, reprenable avec `resume: true` et le même scan_id. Le `now` original est relu, même le lendemain. Le lot non acquitté est refait en entier ; les empreintes déjà validées deviennent UNCHANGED, les écritures normales sont rejouables. Une réponse d'acquittement perdue ne fait pas rejouer un lot déjà acquitté. Un changement de contenu du pending ou de total interdit la reprise ; il faut explicitement abandonner le scan et en recommencer un. Une absence ne progresse jamais pendant ces échecs. L'ancien runner conserve son comportement d'abandon.

## Cache des candidats

Avant : pour chaque appel de persistance, relecture de l'enveloppe min/max, y compris les trous et les périodes fallback lointaines ; balayage en mémoire de toute l'enveloppe pour chaque nouvelle occurrence.

Après : union des jours UTC intersectant les ±12 h **des seules occurrences nouvelles**, fenêtres disjointes groupées par 40, pages de 500. Une fenêtre déjà couverte n'est pas relue. Index persistant par jour, jeton de titre/ville, identifiant externe et URL canonique. Les lignes créées/modifiées sont immédiatement indexées. Après chaque appel réussi, un rafraîchissement groupé de 100 activités garantit la fraîcheur des provenances utilisée par les fusions. Les retraits invalident les jours concernés avant désactivation ; les échecs vident le cache. Une écriture intercalée par un autre appel de persistance invalide aussi le cache, y compris entre wrappers de store.

Cache créé une fois par `createDatatourismePoiPersister`, partagé avec la réconciliation via `.candidateCache`. Le caller conserve ce persister pendant le scan, avec le `now` fixe du checkpoint. Il doit être recréé après reprise. Une session suppose un writer applicatif exclusif : une écriture SQL depuis un autre processus n'est pas observable par un cache Node. Le chemin général sans cache reste disponible ; un appel contenant plusieurs descripteurs conserve l'ancien chemin et son ordre inter-sources.

Budget : 100 000 activités et 256 Mio de JSON compact ; dépassement = erreur explicite/retry, jamais troncature ou éviction conduisant à des relectures répétées. Le transport borne aussi l'accumulation paginée. Ces bornes concernent les lignes/JSON ; les objets JavaScript, l'index, ICU et le harnais consomment davantage de mémoire. Aucun index SQL ajouté : pas de mesure SQL/EXPLAIN réelle justifiant une migration supplémentaire.

## Sémantique et limites de complexité

`compareActivities`, ses seuils et `mergeActivities` sont inchangés. L'index ne retire que des paires nécessairement DISTINCT : absence simultanée de jeton commun et d'identité commune, ou villes contradictoires sans identité. Les identités externes sont préfiltrées de manière conservatrice, même en collision de namespace. Le filtrage ±12 h reste celui du pipeline précédent.

L'ordre virtuel reproduit le Map original : candidats initiaux triés par ID puis activités introduites pendant le lot, avec traitement des activités connues situées dans les trous de l'enveloppe. C'est nécessaire pour conserver le premier MATCH gagnant. Les nouvelles lignes restent immédiatement visibles aux occurrences suivantes.

Tests différentiels : titres égaux/proches, villes, cinq minutes, hors fenêtre, multisource, créations intra-lot, 501 candidats, merged, longs/fallback, même début/fins différentes, déplacement d'une activité connue depuis un trou d'enveloppe. Comparaison des activités, décisions REVIEW, cibles de provenance, identifiants externes, historiques et contenu ; seules les dates d'audit du harnais sont ignorées. Un test additionnel vérifie 2 400 paires contre le comparateur original.

Données réelles locales : les 500 premiers POI du scratch JSONL national, 663 occurrences et 3 invalides. Ancien/nouveau : états métier identiques. Ancien : 1 302 lignes candidates relues, 6 pages, 4 271 554 octets ; nouveau : aucune ligne candidate relue, 5 pages vides, 10 lectures groupées de rafraîchissement. Cela ne signifie pas zéro transfert total : les rafraîchissements relisent les activités touchées.

La croissance évitable des relectures et du balayage global est supprimée. Un groupe dense de titres/identités peut toujours produire beaucoup de vrais REVIEW ; préserver toutes ces décisions impose leur coût. Aucune promesse de complexité linéaire pour ce cas intrinsèque.

## Mesures synthétiques reproductibles

Commande : `node sortir/run-candidate-cache-benchmark.js N old|new`, processus séparé pour chaque mesure, stockage Supabase remplacé par un harnais mémoire indexé. 100 POI par appel, une occurrence nouvelle par POI, 500 villes, dates dispersées sur 90 jours et 1 % de fallback très lointains. Ce scénario expose le défaut d'enveloppe croissante ; il ne représente pas un catalogue dense de doublons. Les temps CPU incluent tout le pipeline simulé ; aucune latence SQL/réseau.

| POI | CPU ancien → nouveau | Durée ancien → nouveau | Lignes candidates ancien → nouveau | Pages candidats ancien → nouveau | JSON candidats ancien → nouveau |
| ---: | --- | --- | ---: | ---: | ---: |
| 100 | 24,2 → 24,1 ms | 22,5 → 21,7 ms | 0 → 0 | 1 → 1 | 2 → 2 o |
| 1 000 | 495,3 → 323,3 ms | 328,5 → 259,9 ms | 4 500 → 0 | 15 → 10 | 7,00 Mo → 20 o |
| 10 000 | 18 740 → 2 263 ms | 17 947 → 1 666 ms | 493 137 → 0 | 1 037 → 65 | 772,10 Mo → 130 o |

Le nouveau chemin ajoute respectivement 1 / 10 / 100 lectures groupées de rafraîchissement, soit 100 / 1 000 / 10 000 activités transférées une fois après écriture. À 10 000, ce rafraîchissement représente 15,67 Mo JSON supplémentaires (mesure séparée), soit environ 15,67 Mo de transfert candidats + cache contre 772,10 Mo auparavant. Sur les 500 POI réels, il représente 2,15 Mo contre 4,27 Mo de relectures candidates auparavant. Ces volumes ne sont pas inclus dans les colonnes « candidats ». Le reste des lectures de provenance/historique est commun aux deux chemins.

| POI | Pic heap ancien → nouveau | Pic RSS ancien → nouveau | Cache JSON au pic |
| ---: | --- | --- | ---: |
| 100 | 8,9 → 10,7 Mio | 66,3 → 66,5 Mio | 0,10 Mio |
| 1 000 | 25,9 → 19,6 Mio | 171,5 → 140,0 Mio | 1,03 Mio |
| 10 000 | 141,9 → 83,5 Mio | 489,1 → 647,0 Mio | 10,36 Mio |

Le pic RSS n'est donc **pas** amélioré à 10 000 malgré la baisse du heap observé ; il comprend toute la fausse base en mémoire et les allocations natives/transitoires. Une mesure réelle contrôlée est nécessaire pour fixer la mémoire du worker. Ne pas assimiler la borne JSON à une borne RSS.

Extrapolation illustrative pour 61 289 POI à une occurrence : CPU nouveau ~14 s si croissance linéaire ; ancien ~704 s si prolongation quadratique à partir de 10 000. Ce ne sont pas des durées de scan réseau. Cache JSON ~64 Mio dans ce scénario ; pour les 79 364 occurrences nationales initiales, ~82 Mio à taille unitaire identique. Le nombre d'activités multisources déjà présentes peut faire atteindre le plafond et arrêter le run en sécurité.

## Journée calme nationale : modèle explicite

Recalcul local complet du scratch au 21/10 10 h UTC puis J+1 : 61 289 reçus, 58 658 UNCHANGED, 2 296 CHANGED, 4 NEW auparavant invalides, 331 invalides restants. Parmi les 2 300 à traiter : **8 627 occurrences actuelles, 8 404 conservées, 223 ajoutées, 2 463 retirées**. Le temps qui avance ne crée donc pas 2 300 nouvelles activités.

Modèle : groupes de 1 000 dans l'ordre du fichier, persister de 100 POI, aucune modification source, anciens hashes à jour, une activité par occurrence, pas de REVIEW/MATCH supplémentaire avec une autre source, pas de legacy à migrer. 62 appels au pipeline. Les compteurs suivants sont des requêtes HTTP, pas des lignes modifiées :

| Poste | Lectures Supabase | Écritures / RPC mutantes |
| --- | ---: | ---: |
| Comparaison des états | ≤123 | 62 empreintes après succès |
| Contrôle national et finalisation | 0 | 126 |
| Réconciliation des retraits | 62 historique + 62 soutiens | 62 désactivations + 62 stale |
| Pipeline : clés v2/legacy, activités connues, cache, comptage | ~198 + 62 + 113 + 62 = 435 | — |
| Pipeline : suivi des runs/source, touches, historique | — | ~310 + 62 + 62 = 434 |
| 223 nouvelles occurrences DISTINCT | — | ~892 (4 par occurrence) |
| Fenêtres candidates | Q, selon stock réellement présent | 0 |
| **Total indicatif** | **~682 + Q** | **~1 638** |

Soit ~2 320 + Q requêtes Supabase/jour et **613 requêtes DATAtourisme**, hors reprises. Les recherches de candidats Q dépendent du stock multisource et de sa répartition temporelle : il serait trompeur de les donner exactement sans lire la base. Une fenêtre se paie une fois par session, puis par pages de 500 ; les rafraîchissements de mutations restent distincts. Des historiques plus volumineux, activités partagées, REVIEW, collisions, réactivations ou erreurs changent ces chiffres. La finalisation de POI totalement absents reste une seule RPC atomique, avec travail SQL proportionnel au stock.

Ce volume HTTP est raisonnable comme objectif pour une petite instance, mais ne démontre ni la latence ni la charge SQL réelle. Les checkpoints font toujours ~61 289 updates d'observation. Le pipeline conserve ses écritures individuelles pour les 223 vraies nouveautés ; l'optimisation ne les dissimule pas. Une modification éditoriale massive produirait une autre journée et un autre coût.

## Validation et périmètre

Régression complète : **463/463 vérifications vertes dans 27 scripts** : scripts `sortir/test-*.js` et `test-sortir-auto-ingest.js`. Les tests existants ne sont ni supprimés ni affaiblis. Tests et benchmarks utilisent uniquement des stores/HTTP factices et le fichier national déjà téléchargé. Les nouvelles fonctions PL/pgSQL n'ont pas été exécutées sur PostgreSQL ; leur validation transactionnelle réelle reste précisément l'étape contrôlée suivante.

Fichiers de cette étape : `supabase-persistence.js`, `datatourisme-poi-reconciliation.js`, `datatourisme-national-scan.js`, migration proposée, `temporal-candidate-cache.js`, `candidate-memory-harness.js`, les deux runners candidats, les deux nouveaux fichiers de tests et cette documentation. Les autres fichiers non suivis des étapes précédentes sont conservés.

Verdict : prêt pour **validation contrôlée de la migration et d'un petit lot**, avec mesure RSS et vérification SQL transactionnelle ; aucune autorisation implicite de lancer le national complet. Scheduler, plafond 300 et OpenAgenda inchangés. Aucune migration appliquée, donnée Supabase écrite, ingestion réelle ou opération commit/push.

## Git status final

HEAD `1f1e4ef` ; un fichier suivi modifié, seize fichiers non suivis, aucun changement indexé.

```text
 M sortir/supabase-persistence.js
?? migrations/2026-10-21-sortir-datatourisme-poi-states.sql
?? sortir/candidate-memory-harness.js
?? sortir/datatourisme-architecture-performance.md
?? sortir/datatourisme-national-scan.js
?? sortir/datatourisme-poi-reconciliation.js
?? sortir/datatourisme-poi-state.js
?? sortir/datatourisme-poi-state.md
?? sortir/run-candidate-cache-benchmark.js
?? sortir/run-candidate-real-differential.js
?? sortir/run-datatourisme-poi-state-prototype.js
?? sortir/temporal-candidate-cache.js
?? sortir/test-datatourisme-batch-checkpoint.js
?? sortir/test-datatourisme-national-scan.js
?? sortir/test-datatourisme-poi-reconciliation.js
?? sortir/test-datatourisme-poi-state.js
?? sortir/test-temporal-candidate-cache.js
```
