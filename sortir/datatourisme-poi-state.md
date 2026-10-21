> Optimisation ultérieure : le chemin opt-in par lots et ses coûts (126 RPC de contrôle) sont documentés dans [datatourisme-architecture-performance.md](datatourisme-architecture-performance.md). Les coûts par page ci-dessous décrivent le runner initial conservé comme référence.

# Comparaison durable DATAtourisme — prototype isolé

Le composant d'empreinte n'est importé par aucun scheduler et n'appelle pas `persistSortirIngestion`.
La migration `2026-10-21-sortir-datatourisme-poi-states.sql` est proposée, non appliquée.
Les réconciliations par POI reçu et par absence nationale sont implémentées dans des
composants indépendants. Le cache des candidats, le plafond de production et OpenAgenda
restent hors périmètre. Aucun de ces nouveaux composants n'est branché au scheduler.

## Empreinte v1

`fingerprint = hex(SHA-256(UTF-8(stableJson(document))))`, 64 caractères hexadécimaux minuscules.
`stableJson` trie récursivement les clés des objets. Les ensembles ci-dessous sont dédupliqués
et triés par leur sérialisation complète (pas par une clé partielle pouvant avoir des ex æquo).

```js
document = {
  version: "datatourisme-mnoria-v1",
  uuid: "UUID en minuscules",
  editorial: "KEEP" /* ou DENY */,
  occurrences: [ /* ensemble des occurrences sélectionnées */ {
    sourceRecordId, sourceOccurrenceKey, validationStatus,
    originalEventUrls: [ /* URLs originales canoniques, ensemble */ ],
    activity: { /* projection détaillée ci-dessous */ }
  } ]
}
```

La projection d'activité réutilise `canonicalActivityPayload` : titre, description,
début/fin normalisés UTC, fuseau IANA, statut de cycle de vie, type de localisation,
nom/adresse/code postal/ville/pays/latitude/longitude, URL en ligne, organisateurs,
catégorie/sous-catégorie/tags normalisés, image, réservation, admission, identifiants externes,
confiance et confiance par champ. Les organisateurs, tags, identifiants et preuves sont
traités en ensembles. Les preuves utiles ne conservent que `field` et `excerpt`.

Sont exclus : `fetchedAt`, `now` lui-même, dates de collecte, dates de mise à jour API,
index d'une période dans la réponse, compteurs et diagnostics de sélection, objets bruts
`sourcePayload`, `sourceValue` et `provenanceIndex` de traçabilité, URL de transport/pagination,
métadonnées fournisseur non consommées. L'URL originale du POI est en revanche incluse.

`sourceCategories` ne sert aujourd'hui qu'à la décision KEEP/DENY, `sourceTags` n'est pas
persisté : une variation sans effet éditorial est ignorée. Les champs normalisés
`category`, `subcategory`, `tags`, eux, sont inclus. Le jour où le mapping/taxonomie,
la normalisation, la politique éditoriale, les critères de validation ou les champs utiles
changent, il faut changer `FINGERPRINT_VERSION`. Une version durable différente force CHANGED,
même si un hash identique était fourni.

Pour DENY, `occurrences` est toujours vide : modifier une description refusée ne déclenche
aucune opération Mnoria. Pour KEEP avec aucune occurrence sélectionnée valide, le document
a aussi une sélection vide ; les modifications sans activité affichable sont sans effet.
KEEP et DENY restent distincts. Une erreur de conversion/validation n'est jamais représentée
par une sélection vide : le calcul échoue et aucune référence n'est enregistrée.

`calculatePoiState(poi, { now })` utilise le connecteur existant : fenêtre glissante de
90 jours, plafond chronologique 30, fallback sur la prochaine occurrence. Un `now` explicite
et fixe est obligatoire pour chaque passage. Le temps change le hash seulement s'il change
le résultat Mnoria, y compris une entrée dans la fenêtre, une sortie ou le glissement du plafond.
L'ajout/retrait d'une période non sélectionnée ne change pas le hash tant que le résultat reste identique.

## Pourquoi une nouvelle table

- `sortir_provenances` est indexée par occurrence, avec des payloads volumineux et potentiellement
  plusieurs lignes par POI ; aucun enregistrement pour un nouveau DENY ou un KEEP vide.
  Les hashes existants sont des hashes par occurrence, pas la sélection complète du POI.
- `sortir_activities` est une représentation canonique multisource : plusieurs POI peuvent
  fusionner, et une activité peut rester active grâce à une autre source.
- Les tables de runs sont des journaux, `sortir_sources` a une ligne pour tout le national.
  Les détourner en cache de 61k états impose des jointures/reconstructions ou un gros JSON mutable.

La table proposée a huit colonnes : `poi_uuid` (PK uuid), `fingerprint` (text hex64),
`algorithm_version` (text), `last_observed_at` (timestamptz), `last_observed_scan_id` (uuid),
`absence_count` (smallint 0–2), `last_absence_scan_id` (uuid nullable), `needs_reprocess` (boolean).
Empreinte et version sont toutes deux NULL pour un POI observé mais jamais traité avec succès.
Pas de copie des périodes, de description, de liste d'occurrences, ni d'index supplémentaire.
La PK suffit à la lecture `WHERE poi_uuid = ANY(p_uuids)`.

La réception brute, même invalide, actualise l'observation indépendamment de l'empreinte.
Un checkpoint JSON unique sur la ligne existante `sortir_sources` certifie désormais la complétude
du scan et son identifiant de finalisation. Aucun journal ni nouvelle table de scans.
Les provenances historiques restent utilisées pour la réconciliation des occurrences.

## API et protocole de succès

1. `calculatePoiState` ou `fingerprintCalculatedPoi` calcule un état sans I/O.
2. `comparePoiStates({ states, store })` lit les références par 500 et renvoie `classified`,
   `toPersist` (NEW/CHANGED seulement), `unchanged`. Aucune écriture.
3. `processPoiStateBatch` propose un protocole indépendant : `applyChanges(toPersist)` doit
   renvoyer des accusés par UUID `{ uuid, persistence: "completed", reconciliation: "completed" }`.
   Seuls ces succès complets sont enregistrés. Un résultat omis, partiel, échoué, une exception
   ou une panne d'enregistrement conserve l'ancienne référence (ou NEW). Le prochain passage rejoue.
   Le callback doit être idempotent. Il n'existe pas de callback de production par défaut.
4. UNCHANGED est exclu du callback ; seule sa dernière observation est mise à jour, en batch,
   sans écrire son empreinte. Cette observation ne modifie pas les provenances.

Pour DENY et KEEP vide, il faudra aussi confirmer la réconciliation avant de valider la référence.
**Ne pas fabriquer l'accusé de réconciliation à partir du seul succès du pipeline actuel.**
Le prototype national simule ce succès exclusivement dans une Map mémoire.

Les RPC nationales verrouillent la ligne source et interdisent deux scans simultanés.
Le contrat continue à imposer que les autres écritures d'état passent par ce scanner sérialisé :
aucun système général de coordination de plusieurs writers n'est ajouté. Il faudra invalider/
reconstruire les références si le stock Mnoria est restauré ou modifié hors de ce mécanisme.

## Transport Supabase et coûts

Lecture par RPC POST `sortir_load_datatourisme_poi_states(p_uuids uuid[])`, 500 UUID maximum.
Un GET `.in()` de 500 UUID pourrait dépasser la limite d'URL constatée ; le POST évite ce risque.
Observation UNCHANGED par RPC POST séparée ; références réussies par upsert POST de 500 lignes.
RLS activée, accès réservé à `service_role`, aucune policy ni fonction SECURITY DEFINER.

Pour N POI : `ceil(N/500)` lectures, soit 123 pour 61 289. Premier passage réussi :
123 upserts de référence. Passage identique : zéro upsert d'empreinte, 123 observations groupées
si on conserve la dernière observation de chaque POI. À J+1, upserts seulement pour les succès
NEW/CHANGED, plus les observations UNCHANGED. Un traitement par lots d'entrée peut fragmenter
les écritures : `sum(ceil(changements_dans_lot/500))`, pas forcément `ceil(total_changements/500)`.
Ce comptage exclut toute écriture du pipeline d'activités et toute future réconciliation.

## Reproduction sans écriture Supabase

```sh
node sortir/test-datatourisme-poi-state.js
node sortir/run-datatourisme-poi-state-prototype.js --input /private/tmp/catalogue.jsonl --now 2026-10-21T10:00:00Z
# Lecture API explicite, fichier de destination nouveau, exclusivement dans le scratch :
node sortir/run-datatourisme-poi-state-prototype.js --download /private/tmp/catalogue.jsonl --now 2026-10-21T10:00:00Z
```

Ne simuler un fichier téléchargé qu'après le message `downloadComplete: true`.
Le format est une ligne JSON par POI. Trois lectures du même snapshot comparent J, J identique,
J+1 à données brutes constantes. Les erreurs restent hors des références et sont comptées.
La mémoire inclut l'état de référence complet, le lot de 500, les buffers du lecteur et le GC Node.
`fingerprintMs` isole projection/validation/hash ; `calculationMs` inclut aussi le connecteur et
la sélection temporelle. Les temps du passage incluent la lecture JSONL et la comparaison mémoire.
Une journée calme simulée mesure uniquement le changement temporel ; les modifications réelles
et arrivées/suppressions du lendemain demanderaient un second snapshot réel.

## Mesures historiques du premier prototype (cinq colonnes), 21 octobre 2026

Snapshot en lecture seule : 61 289 POI, 613 requêtes, 257,9 secondes, 128 449 510 octets JSONL.
Instant de référence : `2026-10-21T10:00:00Z` (14 h à La Réunion), J+1 à la même heure.
Fichier scratch : `/private/tmp/datatourisme-national-poi-state-2026-10-21.jsonl`.
Rapport brut : `/private/tmp/datatourisme-poi-state-national-report.jsonl`.

| Passage | NEW | CHANGED | UNCHANGED | Erreurs hors référence | Temps total | Projection/hash |
|---|---:|---:|---:|---:|---:|---:|
| Premier | 60 954 | 0 | 0 | 335 | 12,18 s | 3,10 s |
| Identique | 0 | 0 | 60 954 | 335 | 11,84 s | 3,01 s |
| J+1 | 4 | 2 296 | 58 658 | 331 | 11,92 s | 2,96 s |

Les erreurs ont toutes le code `ends_before_start`. Elles ne deviennent jamais une référence
UNCHANGED. Les quatre NEW à J+1 correspondent à des POI initialement en erreur dont la période
invalide est sortie de la sélection. À source strictement constante, **2 300 POI** entreraient
dans le callback de persistance/réconciliation future ; les 331 erreurs restent à diagnostiquer
et retenter séparément. Le snapshot n'est pas artificiellement corrigé pour obtenir « tous NEW ».

Le premier passage calcule 53 341 KEEP et 7 613 DENY (hors erreurs), pour 79 364 occurrences
sélectionnées. À J+1 : 77 124 occurrences sur les POI calculables. Ces nombres ne simulent
aucune disparition nationale ni écriture dans les activités.

### État compact et mémoire du processus

- Ligne JSON de référence : 286 octets moyens, cinq colonnes seulement. 60 954 références :
  17 432 844 octets ; projection à 61 289 références : 17 528 654 octets (17,5 Mo).
  Ce n'est pas une mesure de stockage PostgreSQL : tuples, pages et PK n'ont pas été mesurés.
- Mesure isolée d'une Map de 61 289 lignes synthétiques du même format : +13,73 Mio de heap
  après GC, +36,81 Mio de RSS. Les valeurs communes y sont partagées ; c'est un ordre de grandeur,
  pas la mémoire réelle du scan national.
- Prototype complet, trois passages dans un même processus : pic échantillonné heap 141,25 Mio,
  pic RSS natif inclus 842,20 Mio. Premier passage : pic RSS 650,81 Mio.
- Témoin séparé, même snapshot, **convertisseur existant seul**, sans empreinte ni Map d'état :
  8,30 s, heap 31,90 Mio, RSS 542,98 Mio. Le RSS élevé n'est donc pas la taille du cache d'état.
  Les pics dépendent du GC et incluent les allocations natives de la conversion/validation.
  Aucun cache temporel des candidats ni changement au convertisseur n'a été introduit ici.

### Requêtes de l'état uniquement (simulées, zéro requête Supabase réelle)

Sur les 60 954/60 958 POI calculables : 122 lectures par passage.

| Passage | Lectures | Upserts d'empreintes après succès | Observations UNCHANGED | Total |
|---|---:|---:|---:|---:|
| Premier | 122 | 122 | 0 | 244 |
| Identique | 122 | 0 | 122 | 244 |
| J+1, flush par lot d'entrée de 500 | 122 | 122 | 122 | 366 |

À J+1, les différences sont dispersées dans les 122 lots : chaque lot donne un petit upsert.
Si un futur appelant regroupe globalement les lignes réussies et les observations, les bornes
sont 5 upserts d'empreintes et 118 observations, soit 245 requêtes avec les 122 lectures.
Le prototype choisit le flush simple par lot et ne prétend pas implémenter ce regroupement global.
Pour 61 289 POI tous calculables, compter 123 lectures, jusqu'à 123 upserts et 123 observations
selon la répartition. Même UNCHANGED écrit la dernière observation : zéro upsert d'empreinte
ne signifie pas zéro ligne SQL mise à jour. Les coûts du pipeline coûteux restent hors de ces chiffres.

Validation du premier prototype : 23 fichiers de tests Sortir, 392 vérifications réussies, dont 32 nouvelles.
Réseau réel interdit dans les nouveaux tests ; SDK Supabase testé avec un transport factice.
La migration SQL n'a été ni appliquée ni validée sur un serveur PostgreSQL réel.

## Étape suivante : POI invalides et réconciliation des occurrences reçues

### Isolation avant toute persistance

`calculatePoiStateBatch(pois, { now })` renvoie `{ states, errors, stats }`. Une erreur
de validation/conversion est attachée au seul POI concerné. `stats` expose `received`,
`calculated`, `invalid` et les compteurs `errorCodes`. Aucun état vide de remplacement
n'est créé sur erreur : l'ancien état durable et ses anciennes provenances restent intacts.
Le POI sera recalculé au passage suivant. Un KEEP correctement calculé avec zéro occurrence
est, lui, un vrai état vide ; un DENY explicite est un vrai refus éditorial.

Vérification hors ligne sur le snapshot national conservé : 61 289 reçus, 60 954 calculables,
335 erreurs `ends_before_start`. Retenter les 335 erreurs avec le même instant produit
335 erreurs et zéro état validable. Aucune requête Supabase. Rapport scratch :
`/private/tmp/datatourisme-invalid-isolation-report.json`.

`processReceivedPoiBatch` ne passe que les états calculés NEW/CHANGED au callback de
persistance. Les UUID en erreur ne sont ni chargés pour réconciliation ni enregistrés ni
observés comme une nouvelle référence. La liste d'erreurs devra être conservée par le futur
scan national pour ne jamais confondre erreur et absence du catalogue.

Les erreurs de lecture/persistance/réconciliation ne sont pas masquées comme des erreurs
de conversion. Elles empêchent la validation des nouvelles références concernées.

### Réconciliation après la persistance normale

`datatourisme-poi-reconciliation.js` fournit :

- `createDatatourismePoiPersister({ store, now })` : adaptateur du pipeline normal, par lots
  de 100 POI. Un chunk partiel reste entièrement à rejouer ; son succès par POI n'est pas deviné.
- `processReceivedPoiBatch(...)` : calcul isolé → comparaison durable → persistance des
  NEW/CHANGED calculables → réconciliation des seuls succès explicites → validation des empreintes.
- `reconcileReceivedPoiOccurrences(...)` : différence groupée pour ces seuls POI reçus,
  sans décision sur ceux absents du lot ou du catalogue.
- `createSupabasePoiReconciliationStore(client)` : transport RPC POST borné, aucun client
  réel créé implicitement et aucune activation dans le scheduler.

L'adaptateur normal passe `reconcileDisappearances: false` au pipeline. Ce nouveau paramètre
a la valeur **true par défaut** : le comportement des appels existants et du scheduler ne change
pas. Il désactive uniquement le balayage GLOBAL par ancienneté pour ce chemin explicite.
Sinon un chunk voisin pourrait toucher un POI invalide ancien, bien qu'exclu de la conversion.

Algorithme :

1. Vérifier les états NEW/CHANGED et leur empreinte avant toute désactivation.
2. Charger les provenances historiques DATAtourisme de ces UUID, pour le `source_id` attendu.
   La clé `source_record_id = datatourisme:{uuid}:...` délimite le POI. Les autres POI/sources
   restent hors périmètre, même s'ils partagent une activité canonique.
3. Comparer en mémoire les paires `(source_record_id, source_occurrence_key)` aux occurrences
   sélectionnées. Les anciennes clés legacy restent reconnues exactement comme par le pipeline :
   même début/record et même fin canonique, si aucune provenance v2 ne les remplace.
4. Désactiver en batch les provenances retirées encore actives, sans supprimer de ligne.
5. Relire en batch les soutiens des activités concernées, y compris pour les provenances
   **déjà inactives**. Ce dernier point permet le rejeu après une panne intermédiaire.
6. Passer en `stale` les seules activités active/review sans provenance active. La requête
   d'écriture vérifie de nouveau `NOT EXISTS` pour ne pas déclasser une activité désormais soutenue.
7. Valider les empreintes uniquement après succès de l'ensemble persistance + réconciliation.

Les sorties naturelles de la fenêtre glissante suivent cette même différence, puisqu'elles
proviennent d'un POI reçu dont la sélection a été calculée avec succès.

### Rejouabilité

Une panne après désactivation mais avant stale ne valide aucune empreinte. Au rejeu, la lecture
inclut les lignes inactives retirées : la vérification de soutien et le stale sont terminés.
Une panne après stale mais avant validation de l'état durable entraîne aussi un rejeu sans doublon.
La réapparition d'une occurrence utilise le pipeline normal : sa provenance existante est
réactivée et son activité stale est réactivée, sans nouvelle ligne d'activité/provenance.

Le pipeline persiste d'abord les occurrences sélectionnées. Si une partie échoue, les POI non
certifiés réussis ne sont pas réconciliés et leur empreinte reste ancienne. Si une réconciliation
batchée échoue, aucune nouvelle référence de ce batch de succès n'est validée ; le rejeu traite
les écritures déjà réussies de façon idempotente. Les transactions HTTP multiples ne constituent
pas une transaction globale : les nouvelles occurrences peuvent être visibles avant la fin,
mais la référence durable ne certifie jamais un traitement incomplet.

Un deuxième passage identique ne modifie ni activités, ni provenances, ni empreintes et ne
fait aucun appel de réconciliation. La dernière observation de l'état peut toujours être actualisée.
Le contrat conserve l'hypothèse d'un scanner sérialisé ; aucun verrou distribué n'est ajouté.

### SQL proposé et coûts supplémentaires

À cette étape intermédiaire, la table d'état avait cinq colonnes. Quatre RPC ont été ajoutées à la migration non appliquée :
`sortir_load_datatourisme_poi_provenances`, `sortir_deactivate_datatourisme_provenances`,
`sortir_load_activity_supports`, `sortir_stale_unsupported_activities`.
Elles sont SECURITY INVOKER et réservées à `service_role`. Aucun DELETE ni index nouveau.

Les listes d'UUID/IDs sont dans le corps POST, 500 maximum. La lecture historique est paginée
par 500 lignes avec total exact et tri stable ; une réponse tronquée, dupliquée ou sans total
échoue au lieu de certifier une réconciliation incomplète. Les soutiens sont des booléens
`EXISTS`, sans jointure embarquée susceptible de tronquer les provenances actives.

Notations : H_g = nombre de lignes historiques pour chaque groupe de 500 POI ; R = nombre
de provenances à désactiver ; A = activités historiques retirées à vérifier ; S = activités
sans soutien à passer en stale. Nombre d'allers-retours HTTP supplémentaires :

```text
lecture historique : somme_g max(1, ceil(H_g / 500))
désactivation       : ceil(R / 500)
lecture des soutiens: ceil(A / 500)
écriture stale      : ceil(S / 500)
```

Exemple vérifié avec le vrai SDK et un transport factice, **quatre historiques/POI après
persistance (A/B/C/D), sélection B/C/D, une retirée par POI, activité distincte sans autre soutien** :

| POI CHANGED | Lectures historiques | Lectures soutiens | Désactivations | Écritures stale | Total |
|---|---:|---:|---:|---:|---:|
| 100 | 1 | 1 | 1 | 1 | 4 |
| 500 | 4 | 1 | 1 | 1 | 7 |
| 2 300 | 19 | 5 | 5 | 5 | 34 |

Ces chiffres excluent la comparaison/observation d'état durable et le pipeline de persistance
normal. Ils varient avec le nombre d'historiques et d'activités distinctes, pas simplement avec
le nombre de POI. Si aucun retrait n'existe : lecture historique seule ; aucun UNCHANGED ne
paie ce coût. Aucun gain de temps SQL réel n'est affirmé sans migration appliquée ni EXPLAIN.

Validation de cette étape : 24 fichiers Sortir, 420 vérifications réussies, dont 28 tests de
réconciliation (pipeline normal sur MemoryStore, SDK sur transport factice). Cas couverts :
invalides isolés/retentés, ancien état protégé, erreurs de conversion/API/persistance,
ajout/retrait, temporalité, multisource active/review, autre POI fusionné, échec entre
désactivation et stale, rejeu, réactivation, clés legacy, pagination >1000 lignes et coûts batchés.

## Réconciliation nationale : deux absences confirmées

### Modèle durable minimal

`sortir_datatourisme_poi_states` est conservée et étendue, pas remplacée :

| Colonne | Rôle |
|---|---|
| `last_observed_scan_id` / `last_observed_at` | Dernière réception brute dans le catalogue, valide OU invalide |
| `fingerprint` / `algorithm_version` | Dernière référence métier réussie ; paire NULL si jamais calculable |
| `absence_count` | 0 = vu ; 1 = première absence finalisée ; 2 = absence confirmée et réconciliée |
| `last_absence_scan_id` | Scan réussi qui a fait progresser cette absence ; NULL après réapparition |
| `needs_reprocess` | Vrai après désactivation nationale ; force CHANGED jusqu'au succès d'une réapparition |

Chaque observation remet immédiatement `absence_count` à zéro et annule `last_absence_scan_id`.
Elle ne remplace jamais l'empreinte ni ne remet à faux `needs_reprocess` : ces deux opérations
attendent la réussite de la persistance ET de la réconciliation par POI. Un POI réapparu avec
le même contenu doit repasser par le pipeline pour réactiver ses anciennes provenances/activités.

Une seule colonne JSON `sortir_sources.datatourisme_national_scan` sert de checkpoint mutable :
identifiant UUID neuf du scan, statut running/complete/failed/finalized, URL suivante, total annoncé,
nombre de pages et UUID acquittés, page en attente et dernier résultat de finalisation.
Ce n'est pas un historique. Les anciens appels de finalisation sont soit servis depuis le dernier
résultat mémorisé, soit rejetés comme périmés ; aucun ne fait progresser les compteurs.

### Définition exacte d'un scan complet réussi

`datatourisme-national-scan.js` construit le périmètre national lui-même : endpoint
`/entertainmentAndEvent`, champs existants du connecteur, langue fr, pages de 100,
filtre futur/en cours identique au connecteur. Aucun filtre géographique, recherche ou plafond de POI.
Le transport HTTP explicite rejette toute réponse autre que 200 (dont quota 429 et partiel 206).

Pour CHAQUE page, dans l'ordre :

1. Vérifier le total entier positif et stable, la taille ≤100, les UUID, l'URL de reprise
   et la conservation exacte du périmètre ; suivre `meta.next`, jamais fabriquer un tour limité.
2. Observer durablement les UUID avant conversion par `sortir_dt_observe_national_page`.
   La RPC refuse les UUID déjà vus et conserve un checkpoint « page en attente ».
3. Traiter le lot avec `processReceivedPoiBatch`. Tous les UUID doivent être comptabilisés
   une seule fois : UNCHANGED, NEW/CHANGED entièrement persistés/réconciliés et committés, ou erreur
   isolée de conversion explicitement identifiée. Un succès partiel de persistance est un échec de scan.
4. Acquitter la page avec `sortir_dt_finish_national_page`. Le statut complete n'est atteint
   que sur la dernière page, sans `next`, avec exactement autant d'UUID distincts reçus que le total.

Les pages cycliques, UUID non identifiables, totaux changeants, fin prématurée, limite de pages,
chunks échoués, erreurs réseau/HTTP ou crashes ne certifient jamais un scan complet.
Un catalogue national vide est refusé par précaution ; ce cas nécessite une vérification explicite,
pas une désactivation automatique de tout le catalogue.

`runNationalScan` renvoie complete, mais **ne finalise jamais les absences automatiquement**.
`finalizeNationalScan({ sourceId, scanId, now, store })` est une opération distincte. Le serveur
vérifie de nouveau le checkpoint complet, même si le client tente de finaliser un scan incomplet.
Après un crash, un scan running doit être abandonné explicitement via `failScan` avant un nouvel
UUID de scan. Un scan complete peut être finalisé ou abandonné. Aucun timeout ne certifie un succès.

Les attestations de réussite HTTP/chunk proviennent du runner ; les RPC contrôlent durablement
leur ordre, unicité et cardinalité. Ces fonctions ne doivent pas être contournées par un autre writer.

### Invalides, échecs et réapparition

Les 335 POI invalides du snapshot sont bien des POI **observés**. Leur empreinte reste ancienne,
ou NULL si nouvelle identité, et leurs occurrences ne sont pas touchées par la conversion échouée.
Ils ne font pas progresser l'absence et seront retentés. Les observations UNCHANGED ne sont pas
réécrites une seconde fois par le pipeline : le runner les a déjà enregistrées durablement.

Un scan failed/interrompu ne fait progresser AUCUNE absence. Une réception positive peut
toutefois annuler une première absence même dans un scan ensuite échoué : c'est conservateur.
Les scans échoués ne comptent pas dans la succession des scans complets réussis.

- J1 présent, J2 absent, J3 présent : compteurs 0 → 1 → 0, aucune désactivation.
- J1 présent, J2 absent, J3 absent : 0 → 1 → 2, désactivation nationale à J3.
- J4 présent : compteur remis à 0 dès réception ; `needs_reprocess` force le pipeline même
  à empreinte identique. Le succès réactive les lignes existantes puis efface cet indicateur.
- J4 présent mais invalide : absence annulée ; aucune empreinte remplacée et retry forcé conservé.

### Finalisation atomique et idempotence

`sortir_dt_finalize_national_scan` est UNE transaction SQL / RPC POST, réservée à service_role :

1. Verrouiller la source et vérifier le scan complete. Même `scan_id` déjà finalisé : résultat
   mémorisé immédiatement, aucune écriture supplémentaire. Scan périmé/incomplet : exception.
2. Pour les états non observés, faire progresser 0→1 ou 1→2 ; un état déjà à 2 ne progresse plus.
3. Pour les nouveaux 2, désactiver toutes leurs provenances DATAtourisme du `source_id` attendu.
   Les historiques inactifs participent aussi à l'identification des activités à vérifier.
4. Mettre en stale uniquement les activités active/review sans AUCUNE provenance active restante,
   toutes sources/POI confondus. Ne supprimer aucune ligne ni empreinte.
5. Conserver le résultat et le statut finalized sur la source dans la même transaction.

Une panne avant COMMIT annule compteurs, désactivations et stale ensemble ; le rejeu reprend
depuis complete. Si COMMIT réussit mais que la réponse réseau est perdue, le rejeu renvoie le
résultat mémorisé. Aucun découpage HTTP au milieu des écritures de finalisation.

### Coût Supabase de finalisation

La sélection des absents et les écritures sont ensemblistes côté PostgreSQL : **1 RPC mixte**,
sans lectures HTTP séparées ni listes d'UUID transférées au client, quel que soit le nombre d'états.
Le serveur lit le checkpoint et recherche les absents parmi les 61 289 états ; une requête HTTP
ne signifie donc pas un coût SQL constant. Test du transport SDK et modèle mémoire, pas mesure SQL réelle.

Hypothèse pour les confirmations : trois provenances/activités par POI, sans autre soutien.

| Cas sur 61 289 états | Lectures HTTP séparées | RPC mixte | États POI modifiés | Provenances désactivées | Activités stale |
|---|---:|---:|---:|---:|---:|
| Aucun absent | 0 | 1 | 0 | 0 | 0 |
| 100 premières absences | 0 | 1 | 100 | 0 | 0 |
| 100 absences confirmées | 0 | 1 | 100 | 300 | 300 |
| 1 000 absences confirmées | 0 | 1 | 1 000 | 3 000 | 3 000 |

Chaque nouvelle finalisation écrit aussi UN checkpoint source. La même finalisation rejouée
fait toujours une RPC mais uniquement une lecture/verrou du résultat, aucune écriture SQL.
Les activités multisources ont un nombre de stale inférieur ou nul.

Ce tableau n'inclut pas le travail de collecte/observation déjà effectué : le protocole explicite
coûte 1 début + 2 RPC par page (observation, acquittement) + 1 finalisation, soit **1 228 RPC de
contrôle pour 613 pages**. Ces opérations sont batchées par page, jamais par POI. Le traitement
d'empreintes fourni reçoit lui aussi des pages de 100 : jusqu'à 613 lectures de comparaison,
puis les écritures et le pipeline pour les seuls changements. Aucun regroupement supplémentaire
de pages ni optimisation des candidats/bootstrap n'a été introduit à cette étape.

### Validation

Les tests de `test-datatourisme-national-scan.js` utilisent le pipeline normal sur MemoryStore,
un modèle transactionnel du checkpoint SQL et le SDK Supabase sur un transport factice.
Ils couvrent réapparition, invalides, interruptions après 10 pages, erreur API page 3,
quota/partiel HTTP, échec de chunk, finalisation omise/prématurée, rollback et rejeu, multisource,
et les quatre volumes du tableau. Les tests préexistants sont conservés ; le fichier de tests
de réconciliation expose seulement ses fixtures sous `require`, sans exécuter sa suite à l'import.
Tous ses tests restent exécutés quand le fichier est lancé normalement.

La migration n'est pas appliquée et la fonction SQL n'est pas exécutée sur une vraie base.
Aucune ingestion, écriture Supabase, activation scheduler, modification du plafond 300,
optimisation des candidats, modification OpenAgenda ni commit/push.

Validation finale de cette étape : **442/442 vérifications, 25 fichiers de tests**, dont
22 tests nationaux ajoutés. Log scratch : `/private/tmp/sortir-national-absence-suite.log`.
