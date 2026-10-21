# Validation réelle contrôlée DATAtourisme — 21 octobre 2026

Verdict **A : prêt pour un dernier test intermédiaire contrôlé**. Aucun test supplémentaire n'est lancé automatiquement.

## Correction et audit SQL

Le COMMIT prématuré a été retiré et placé en dernière instruction : un seul BEGIN/COMMIT couvre table, colonne de checkpoint, contraintes, index primaire, quinze fonctions et tous les grants/revokes. Aucune logique métier modifiée.

Migration **appliquée avec succès**, via l'éditeur SQL du projet Supabase déjà ouvert. Le texte exécuté correspond au fichier corrigé après retrait des commentaires/espaces (19 063 caractères, contrôle FNV32 2610530561). Le schéma réel a été audité par OpenAPI et catalogues PostgreSQL avant application : types text/uuid/timestamptz/boolean conformes, contraintes de statuts compatibles, index existants conservés, aucun conflit avec des objets déjà installés.

Après application : huit colonnes d'état, clé primaire UUID, RLS actif, quinze RPC SECURITY INVOKER avec search_path=public, droits d'exécution service_role présents, aucun droit d'exécution anon/authenticated. Aucun SECURITY DEFINER. Aucune mutation des activités/provenances au niveau supérieur de la migration, aucun DELETE/DROP/TRUNCATE.

Les droits effectifs de table ont été vérifiés : anon/authenticated n'ont aucun grant ; service_role possède également DELETE/TRUNCATE/REFERENCES/TRIGGER via les droits par défaut du projet, en plus de SELECT/INSERT/UPDATE explicitement demandés par le fichier. Le propriétaire postgres conserve ses droits. Le service reste un rôle administratif ; les RPC ne deviennent pas publiques.

La migration est à exécuter **une seule fois** : un rejeu de CREATE TABLE/CREATE FUNCTION échouerait, avec rollback de toute la transaction. Pas de IF NOT EXISTS susceptible de masquer un schéma divergent. Ne pas la réappliquer pour refaire le test.

## Validation réelle des RPC

Test PostgreSQL transactionnel avec verrou exclusif de la table d'état initialement vide, deux UUID fictifs vérifiés sans provenance métier et checkpoint de source restauré par ROLLBACK intégral :

- début/observation/reprise/acquittement batch fonctionnels ; observation et acquittement répétés idempotents ;
- scan incomplet refusé, exception attendue précisément vérifiée ;
- première absence synthétique portée à 1, aucune absence confirmée ;
- finalisation rejouée avec le même scan_id : résultat identique ;
- aucune provenance désactivée, aucune activité passée stale ;
- lectures d'états, historiques et soutiens réellement exécutées ; mutations testées avec tableaux vides ;
- aucune donnée synthétique conservée et checkpoint national revenu à NULL.

Les appels HTTP réels de lecture d'états/historiques/soutiens ont ensuite confirmé l'accès avec le compte applicatif. Aucun scan national partiel n'a été présenté comme complet.

## Lot autorisé et résultats

Exactement vingt POI déjà présents, chacun avec une occurrence existante et une provenance historique unique. Données brutes authentiques issues du téléchargement JSONL local du 21 octobre ; aucune nouvelle collecte API nationale. Sélection locale vérifiée avant écriture : dates identiques aux lignes stockées, résultat MATCH du comparateur existant, aucun retrait prévu. Les anciennes empreintes d'occurrence différaient, le premier passage a donc utilisé leur mise à jour normale.

now logique commun : `2026-10-21T10:00:00.000Z`. Le chemin exécuté est processReceivedPoiBatch avec état durable, persister normal, cache et réconciliation par POI. Pas de runner national ni de finalisation globale sur ces vingt POI. Des garde-fous HTTP additionnels interdisaient toute création d'activité/provenance, désactivation ou stale non vide et toute écriture hors du périmètre prévu. Au second passage, tout appel au callback de persistance aurait provoqué un arrêt.

| Mesure | Passage 1 | Passage 2 |
| --- | ---: | ---: |
| NEW | 20 | 0 |
| CHANGED | 0 | 0 |
| UNCHANGED | 0 | 20 |
| Invalides | 0 | 0 |
| Occurrences repersistées | 20 | 0 |
| Appels au persister | 1 | 0 |
| Empreintes validées | 20 | 0 |
| Provenances retirées/désactivées | 0 | 0 |
| Activités stale | 0 | 0 |
| Candidats chargés | 0 | 0 |
| Activités rafraîchies pour le cache | 20 | 0 |
| Durée du chemin différentiel | 32,17 s | 0,71 s |
| Pic RSS du processus | 128,8 Mio | 125,5 Mio |
| Requêtes REST, précontrôles inclus | 95 | 3 |
| Lectures REST | 9 | 2 |
| Écritures/appels mutants REST | 86 | 1 |

Le premier passage conserve les activités/provenances existantes et ajoute vingt external IDs d'occurrence canoniques. Son coût comprend les mises à jour individuelles du chemin normal pour les hashes historiques différents ; il ne représente pas une journée stabilisée.

Le second passage écrit uniquement l'observation des vingt états en une RPC. Aucun nouveau run, historique, activité, provenance ou external ID ; aucune repersistance métier.

## État DB et intégrité

| Stock | Avant migration/test | Après passage 1 | Après passage 2 |
| --- | ---: | ---: | ---: |
| Activités | 2323 | 2323 | 2323 |
| Provenances | 2539 | 2539 | 2539 |
| External IDs | 7200 | 7220 | 7220 |
| Runs ingestion | 72 | 73 | 73 |
| Runs source | 103 | 104 | 104 |
| Sources | 8 | 8 | 8 |

Table d'état absente avant migration, vide après installation/test SQL annulé, puis vingt références validées après passage 1 et toujours vingt au passage 2.

Statuts avant/après identiques : active 1 024, review 1 017, stale 278, merged 4. Aucun run running avant/après. Aucun orphelin de provenance ou d'external ID, aucun doublon de leurs clés. Les quatre activités sans aucune provenance et les deux signatures répétées (titre normalisé, début, fin, ville) étaient déjà présentes et restent inchangées ; aucune activité active/review sans soutien actif.

Les 96 activités multisources ont exactement les mêmes identités avant/après. Toutes les activités/provenances hors des vingt POI sont strictement identiques aux snapshots initiaux. Tous les anciens external IDs sont conservés ; les vingt ajouts appartiennent uniquement aux activités sélectionnées et à DATAtourisme.

URLs canoniques, débuts et fins des vingt occurrences vérifiés contre les données sélectionnées. Entre les deux snapshots post-passage, les six tables capturées (activités, provenances, external IDs, runs ingestion/source et sources) sont **strictement identiques**, champs d'audit compris. Seuls les états POI, observés séparément par les RPC, sont revus.

## Comptabilité et mémoire

Total REST instrumenté : **186 requêtes = 99 lectures + 87 requêtes mutantes** : 1 lecture OpenAPI, 3 snapshots de 29 lectures, 95 requêtes au passage 1 et 3 au passage 2. Les 87 requêtes mutantes incluent 86 au premier passage et l'unique observation au second ; ce sont des requêtes, pas des lignes. Les snapshots relisent le stock pour l'intégrité et ne constituent pas une ingestion.

En complément : quatre exécutions SQL dans le dashboard (audit, migration, vérification de métadonnées, test transactionnel avec rollback). Les requêtes internes/autosauvegardes du dashboard ne sont pas instrumentées ; ce chiffre ne prétend pas compter tout son trafic HTTP. Aucun appel DATAtourisme pendant cette validation : utilisation du fichier déjà téléchargé.

Cache au pic : vingt lignes, 44 458 octets JSON compact. Heap utilisé après le premier passage ~26,9 Mio ; pic RSS ~129 Mio. Pas d'anomalie observée sur ce petit test, aucune conclusion extrapolée sur la mémoire nationale.

## Tests et Git

**468/468 vérifications vertes dans 28 scripts** : les 463 existantes et cinq contrôles statiques ajoutés. Les contrôles statiques vérifient notamment l'encapsulation transactionnelle jusqu'au dernier grant et l'absence de DML métier au niveau supérieur ; ils ne se substituent pas aux tests PostgreSQL réels réalisés ensuite.

HEAD reste `57c5db5`, branche main. Changements : migration corrigée, nouveau test statique et présent rapport. Aucun code du scheduler, plafond 300 ou OpenAgenda modifié. Aucun commit/push. Arrêt après le second passage des vingt POI.

Snapshots, journaux de requêtes sans secrets, lot figé et runners ponctuels conservés localement dans `/private/tmp/dt-controlled-validation/`. Aucune clé n'est incluse dans le rapport.
