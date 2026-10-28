# Première ingestion production — OpenAgenda Réunion V1

**SAIN POUR BRANCHEMENT SCHEDULER : OUI**, pour les cinq producteurs et les règles V1 validés. Le branchement n’a pas été effectué.

Toutes les valeurs de base et d’API ci-dessous sont **mesurées en production**, et non reprises du dry-run. Date : 28 octobre 2026 ; heures Indian/Reunion (UTC+4).

## 1. État avant et vérifications

Rapport relu : [préparation V1](./openagenda-reunion-v1-report.md). HEAD inchangé : `34a906a89724976257c507d51679298b4e950897`. Les modifications locales sont celles de l’état validé ; aucun code métier modifié pendant cette opération. Empreintes SHA-256 des huit fichiers d’exécution vérifiées avant chaque passage et chaque producteur. `git diff --check` valide ; 17 tests ciblés passent, sans test ignoré.

Avant écriture : **0 run en cours** dans les deux tables de runs ; aucun processus local d’ingestion concurrent identifié. Scan national DATAtourisme finalisé, sans lot en attente. Contrôle répété avant le rejeu et après chaque passage. Les compteurs immédiatement avant écriture correspondent exactement au précontrôle initial : aucune dérive détectée. Les cinq sources sont absentes avant le premier passage. La base contient **0 activité avec code postal 974xx** et **0 activité dans l’emprise réunionnaise contrôlée**.

État avant mesuré à 28/10/2026 16:14:19.

| Table — compteurs globaux | Avant | Après premier passage | Après rejeu |
|---|---:|---:|---:|
| `sortir_sources` | 8 | 13 | 13 |
| `sortir_activities` | 79035 | 79571 | 79571 |
| `sortir_provenances` | 79751 | 80287 | 80287 |
| `sortir_external_ids` | 239204 | 240283 | 240283 |
| `sortir_ingestion_runs` | 788 | 798 | 808 |
| `sortir_source_runs` | 819 | 829 | 839 |
| `sortir_collection_items` | 88619 | 89155 | 89691 |
| `sortir_dedup_decisions` | 715 | 715 | 715 |
| `sortir_datatourisme_poi_states` | 62742 | 62742 | 62742 |

Les tables DATAtourisme et les décisions de déduplication sont inchangées. Les journaux augmentent normalement à chaque passage : +10 ingestion runs, +10 source runs, +536 collection items. Les cinq producteurs donnent dix tranches, car le producteur photographique en nécessite six.

## 2. Résultat exact du premier passage

Source relue à 28/10/2026 16:09:37 ; premier passage terminé à 28/10/2026 16:18:48. Uniquement les cinq producteurs suivants, sans troncature source :

| Producteur | UID agenda | Occurrences ingérées | Active | Review |
|---|---:|---:|---:|---:|
| Bicentenaire de la Photographie | 2568169 | 529 | 223 | 306 |
| CINOR | 50316469 | 2 | 2 | 0 |
| PUI VALIOTECH | 4740352 | 1 | 1 | 0 |
| Innovons La Réunion | 40627992 | 3 | 0 | 3 |
| GCS TESIS | 1059482 | 1 | 1 | 0 |
| **Total** | **5 producteurs** | **536** | **227** | **309** |

**536 activités créées ; 0 activité préexistante mise à jour ; 536 provenances créées ; 1 079 external IDs créés ; 5 sources créées.** Dix runs et dix runs source, tous `completed`, sans erreur. Les écritures métier groupées mesurées correspondent au dry-run : 10 groupes d’activités, 10 de provenances, 15 d’identifiants, 11 bascules de statut ; au maximum 100 lignes par groupe. Aucun conflit ni enveloppe d’écriture en échec.

## 3. État réel et intégrité après ingestion

Contrôle exhaustif des 536 activités, 536 provenances et 1 079 external IDs du lot :

- 227 activités `active`, 309 `review`, **0 stale**, **0 merged**, aucun `merged_into_id` renseigné ;
- **0 doublon d’activité par occurrence attendue**, 0 provenance dupliquée, 0 external ID dupliqué et 0 orphelin détecté ;
- chaque provenance retrouve l’activité et les identifiants attendus ; les 536 lignes d’historique de chaque passage ont une activité et une provenance cohérentes ;
- tous les champs métier, pays, coordonnées, commune, code postal, dates, confiance et preuves correspondent au lot préparé ; aucun code postal ajouté ;
- les 536 `payload_hash` correspondent aux activités canoniques attendues ; les 536 `source_payload` enregistrés correspondent intégralement à leur version assainie prévue, avec métadonnées et créneau source conservés.

| UID événement | Dossier | Commune | Code postal enregistré | Statut | Occurrences |
|---|---|---|---|---|---:|
| 14738514 | Ambition Planète | Saint-Denis | 97490 | active | 2 |
| 32268142 | e-Nov 2026 | Le Port | 97420 | active | 1 |
| 38318793 | Les Rencontres de l’Innovation Énergétique ! | Saint-Leu | NULL conservé | review | 3 |
| 43961004 | Miroirs indianocéaniques | Saint-Denis | 97400 | review | 306 |
| 68013649 | Exposition "Miroirs octographiques" | Saint-Denis | 97400 | active | 223 |
| 93891444 | 2ᵉ séminaire annuel du PUI VALIOTECH - 12 NOVEMBRE 2026 | Saint-Denis | 97400 | active | 1 |

Les longues séries restent **306** et **223 activités distinctes**, chacune reliée à son intervalle exact. Les **536 couples début/fin source** du lot sont retrouvés sans fusion. Ce lot sélectionné ne contient aucun jour avec deux séances distinctes d’un même événement : il n’y a donc pas de paire matin/après-midi réelle à observer ici. Aucune séance n’a été perdue ou fusionnée ; la protection des intervalles distincts passe aussi dans les tests ciblés.

## 4. Explorer réellement publiable

Lecture du vrai moteur Explorer sur la base réelle, puis GET de [l’API Explorer de production — département 974](https://www.agonarena.org/api/explorer/activities?department=974). **HTTP 200 ; 4 cartes ; aucun curseur supplémentaire**. Les quatre identifiants de cartes sont identiques entre moteur et API, aux deux contrôles.

| Carte réellement renvoyée | Commune | Occurrences actives sous-jacentes |
|---|---|---:|
| Exposition « Miroirs octographiques » | Saint-Denis | 223 |
| Ambition Planète | Saint-Denis | 2 |
| 2ᵉ séminaire annuel du PUI VALIOTECH | Saint-Denis | 1 |
| e-Nov 2026 | Le Port | 1 |

Les quatre cartes attendues au dry-run sont donc **effectivement mesurées en production**. Le regroupement d’affichage Explorer ne fusionne pas les lignes d’occurrences en base.

## 5. Dossiers REVIEW

- **Miroirs indianocéaniques : 306 occurrences review** ; ambiguïté de périmètre/date conservée, confiance ciblée sur le début à 0,5.
- **Rencontres de l’Innovation Énergétique : 3 occurrences review** ; code postal **NULL**, confiance géographique ciblée à 0,5, accès non confirmé.

Ces deux dossiers n’apparaissent dans aucune des quatre cartes de l’API. Aucune donnée géographique n’a été inventée pour les publier.

## 6. Deuxième passage et idempotence

Rejeu effectué seulement après le contrôle sain du premier passage. Même lot préparé, mêmes 536 occurrences, même instant source ; aucun nouveau fetch OpenAgenda pendant le rejeu. Empreinte SHA-256 du lot identique aux deux passages :

`2bdc22066cdaec1b2d7a4c6e4cac4faf1459a1fa30f74bdfa9f702e01a9dc77f`

Rejeu terminé à 28/10/2026 16:20:30, contrôle final à 28/10/2026 16:21:04.

| Mesure du lot | Après premier passage | Après rejeu | Delta |
|---|---:|---:|---:|
| Activités | 536 | 536 | 0 |
| Provenances | 536 | 536 | 0 |
| External IDs | 1079 | 1079 | 0 |
| Active | 227 | 227 | 0 |
| Review | 309 | 309 | 0 |
| Stale / merged | 0 / 0 | 0 / 0 | 0 |
| Cartes Explorer production | 4 | 4 | 0 |

Les **lignes d’activités complètes sont strictement identiques**, y compris leurs identifiants, statuts et horodatages. Les external IDs complets sont identiques. Les provenances sont identiques hors champs attendus de suivi de passage ; leur `last_seen_run_id` référence le nouveau run, sans réécriture de contenu source ni de rattachement. L’instant source reste volontairement figé pour ce rejeu exact. Aucun POST/PATCH d’activité ni POST d’external ID ou de provenance pendant le rejeu. Les mises à jour de registre source et de suivi, ainsi que les nouveaux journaux, sont attendues.

## 7. Différences source et anomalies

**Aucune anomalie nouvelle détectée sur le lot ingéré.** La relecture amont diffère du dry-run sur des événements exclus : CINOR renvoie désormais **9 événements**, contre 4 archivés. Cinq UID supplémentaires restent refusés par défaut, sans ingestion :

| UID | Événement supplémentaire exclu |
|---:|---|
| 5246977 | Atelier d’échecs |
| 68345357 | Escape Game « Les protecteurs de la terre » |
| 44566861 | Atelier d’échecs |
| 2664063 | Atelier d’échecs |
| 41861302 | Réparali |

Ces cinq événements ajoutent cinq créneaux. Par ailleurs, le créneau Maison Carrère du 28 octobre, **14:30–15:15**, est désormais terminé et n’entre plus dans les occurrences pertinentes. CINOR passe ainsi de **99 à 103 occurrences source pertinentes**. Le total des cinq producteurs passe de **12 à 17 références événement**, et de **637 à 641 références d’occurrences pertinentes**. Le relais CONNECT’PUI reste exclu des deux agendas. Aucune différence métier sur les six candidats retenus par rapport à l’archive validée ; le lot ingéré reste à 536.

## 8. Arrêt et verdict

**SAIN POUR BRANCHEMENT SCHEDULER : OUI**, au vu des deux passages et des contrôles production ci-dessus, sur ce périmètre V1 uniquement.

Opération arrêtée après le rejeu et ses vérifications. Aucun branchement au scheduler, aucun déclenchement de scheduler, aucune ingestion DATAtourisme ou OpenAgenda nationale, aucun autre agenda, aucune migration, aucun commit et aucun push. Aucun changement des règles métier.

Les preuves détaillées des passages, snapshots et audits sont conservées localement dans `/tmp/oa-reunion-production/` (aucun secret d’accès dans ces fichiers JSON).
