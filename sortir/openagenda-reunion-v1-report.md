# Préparation V1 OpenAgenda La Réunion — 28 octobre 2026

**PRÊT POUR PETITE INGESTION RÉUNION : OUI, sur le lot actif de quatre événements décrit ci-dessous.** Deux autres dossiers sont conservés en revue, sans publication. Aucune ingestion réelle n’a été lancée.

Le rapport d’audit précédent a été relu. HEAD au départ : `34a906a89724976257c507d51679298b4e950897`, dépôt propre. Les chiffres ci-dessous sont calculés sur les réponses publiques relues à **13:52:42, heure de La Réunion**, avec un instant figé pour le replay. La simulation et les tests n’utilisent aucun client Supabase réel. Deux SELECT de contrôle, distincts du harnais, confirment toujours **0 activité en base avec code postal 974xx et 0 activité dans l’emprise réunionnaise**.

## 1. Modifications et temporalité

Le lecteur utilise maintenant par défaut `relative[]=current&relative[]=upcoming`, conformément à la lecture API v2. L’autorité temporelle est exclusivement chaque élément structuré de `timings[]` : début futur, ou fin strictement postérieure à l’instant de sélection. Un créneau terminé ou passé sans fin est exclu. Aucun créneau n’est synthétisé depuis `firstTiming`, `lastTiming`, une durée globale ou du texte. Un horaire mal formé reste soumis à la validation et ne disparaît pas silencieusement.

Avant : événements `upcoming` seulement et 20 premiers créneaux bruts. Après : événements en cours ET futurs, puis tous leurs créneaux pertinents. Sur les cinq producteurs, **637 occurrences de références source** sont lues, soit **636 occurrences uniques par UID/début** après dédoublonnage du relais CONNECT’PUI. Le choix éditorial en retient **536**. Les 100 occurrences uniques rejetées sont détaillées plus bas.

Le plafond implicite de 20 est supprimé. L’option de plafonnement explicite reste compatible avec les anciens appels de démonstration, mais elle s’applique après sélection temporelle et produit un diagnostic de troncature. La V1 ne l’utilise pas. Une lecture plafonnée en événements expose `truncated` et `nextAfter` ; le harnais refuse de certifier une lecture tronquée.

Une API itérative de conversion et un callback asynchrone `onBatch` permettent de traiter les longues séries sans accumuler toutes les activités normalisées. Le traitement respecte l’attente du consommateur ; lots de 100 dans le pilote. Un curseur répété ou une page vide avec curseur provoquent une erreur explicite.

L’emprise géographique est un paramètre optionnel contrôlé du lecteur. Elle est indispensable pour l’agenda national du Bicentenaire : la V1 lit ses deux événements réunionnais, pas ses quelque 1 400 événements nationaux. Les identités d’événement, d’occurrence et les URL canoniques sont inchangées.

## 2. Longues séries et coût de persistance

La sémantique reste **une activité en base par occurrence**, avec ses provenances. Aucun modèle multi-occurrences ou regroupement de données n’a été créé.

Un adaptateur manuel, absent du scheduler, réutilise `persistSortirIngestion`, le write-behind et le cache compact existants. Il traite des tranches de 100, impose la disponibilité des primitives groupées, arrête sur une tranche incomplète et désactive la réconciliation des disparitions pour ces tranches. Le cache est partagé pendant le passage et purgeable en fin de cycle. Il ne crée aucun client ou connexion de son propre chef.

Pour les **536 créations simulées**, l’enveloppe compte :

- 10 insertions groupées d’activités ;
- 10 insertions groupées de provenances ;
- 15 groupes d’identifiants externes ;
- 11 bascules groupées de statut ;
- aucun conflit ni échec, 100 lignes maximum par groupe.

Ces **46 opérations métier groupées** excluent les lectures, les journaux de runs et les collections. Ce sont des compteurs de primitives dans une simulation, pas un benchmark HTTP Supabase. Le cache de candidats a culminé à **536 lignes**, environ **1,01 Mo de JSON compact**, puis a été purgé. Le processus de diagnostic garde aussi les snapshots et résultats pour ses assertions ; sa RSS n’est pas une mesure de mémoire de production.

Le tableau de retour historique reste disponible pour les petits appelants. La borne des résultats normalisés est assurée par le chemin itératif/onBatch utilisé pour la préparation ; la réponse JSON source d’un événement reste nécessairement chargée, y compris son tableau de créneaux. Les métadonnées communes sont partagées en mémoire, et `timings[]` n’est jamais recopié dans chaque `source_payload`.

### Cartes Explorer

Vérification exécutée avec le vrai `lib/explorer.js`, sur un faux client Supabase sans réseau :

- 250 créneaux futurs d’une série : **250 activités, 1 carte** ;
- les mêmes créneaux plus un créneau en cours : **251 activités, 2 cartes**, une par phase ;
- lot actif de cette V1 : **227 activités, 4 cartes**.

Explorer déduplique par titre normalisé, commune, code postal et adresse/lieu, séparément pour les phases future et en cours. Il affiche le créneau représentatif de chaque phase ; il n’agrège pas la période complète de la série dans un nouveau calendrier. Cette logique n’a pas été modifiée.

## 3. Cinq producteurs et résultats du dry-run

Aucun agenda n’a été ajouté à `sortir-auto-ingest.js`. Le périmètre manuel est déclaré dans `openagenda-reunion-v1.js` ; un événement inconnu est refusé par défaut.

| Producteur | UID | Événements source 974 | Occurrences source pertinentes | Événements retenus | Actives simulées | Review simulées |
|---|---:|---:|---:|---:|---:|---:|
| Bicentenaire de la Photographie 2026–2027 | 2568169 | 2 | 529 | 2 | 223 | 306 |
| CINOR | 50316469 | 4 | 99 | 1 | 2 | 0 |
| PUI VALIOTECH | 4740352 | 2 | 2 | 1 | 1 | 0 |
| Innovons La Réunion | 40627992 | 3 | 6 | 1 | 0 | 3 |
| GCS TESIS | 1059482 | 1 | 1 | 1 | 1 | 0 |
| **Total** | | **12 références / 11 UID** | **637 références** | **6 UID** | **227** | **309** |

Les cinq GET d’événements sont complets, une page chacun et aucune troncature. France Travail et Semaine de l’industrie ne participent pas au lot V1.

| Mesure de simulation | Résultat |
|---|---:|
| Événements uniques retenus / rejetés | **6 / 5** |
| Occurrences retenues = activités simulées | **536** |
| Actives / review | **227 / 309** |
| Provenances / external IDs | **536 / 1 079** |
| Comparaisons DISTINCT exécutées sur le lot retenu | **223** |
| MATCH / REVIEW de déduplication sur le lot retenu | **0 / 0** |
| Séries totales / séries actives visibles dans le 974 | **6 / 4** |
| Cartes Explorer | **4** |

Les 309 reviews sont éditoriales/géographiques, pas des doublons ambigus. Les comparaisons DISTINCT ne sont pas stockées comme décisions dans la table de déduplication existante. Les 536 créations ne doivent donc pas être présentées comme 536 comparaisons DISTINCT.

Le relais présent dans les cinq producteurs concerne CONNECT’PUI et est rejeté des deux côtés. Cela explique l’absence de MATCH dans le lot retenu. Il est vérifié séparément avec les autres relais historiques.

### Événements rejetés

| UID | Titre | Occurrences uniques rejetées | Motif |
|---:|---|---:|---|
| 59485599 | Ter’Eco | 2 | Salon collectivités/entreprises, orientation professionnelle, hors sélection V1 |
| 67415611 | Visite guidée de la Maison Carrère | 93 | Visite touristique récurrente, hors sélection éditoriale V1 |
| 74755368 | Collecte solidaire de vêtements et de jouets | 2 | Opération destinée aux agents de la DEAL |
| 43127128 | CONNECT’PUI #2 | 1 | Atelier recherche/entreprises et émergence de projets, hors sélection V1 ; relayé par deux agendas |
| 66169754 | 24h de l’innovation — inscription partenaires | 2 | Inscription réservée aux partenaires |
| **Total** | | **100** | |

## 4. Les six candidats : devenir exact et quatre cartes visibles

Dates et heures ci-dessous en **Indian/Reunion, UTC+4**. Les périodes complètes sont fournies pour la revue humaine ; la carte actuelle affiche le premier créneau représentatif.

| Événement | Commune | Date/période source | Nature | Occurrences | Statut simulé / cartes |
|---|---|---|---|---:|---|
| Exposition « Miroirs octographiques » — 68013649 | Saint-Denis, 97400 | 12/12/2026–29/08/2027 ; première séance 09:00–17:00 | Photographie, exposition, tout public | **223** | **active / 1 carte** |
| Ambition Planète — 14738514 | Saint-Denis, 97490 | 04/11, 08:00–17:30 et 05/11/2026, 08:30–17:00 | Congrès/débats sur la transition écologique, grand public annoncé, inscription | **2** | **active / 1 carte** |
| 2e séminaire annuel du PUI VALIOTECH — 93891444 | Saint-Denis, 97400 | 12/11/2026, 08:30–17:00 | Recherche/innovation, annoncé ouvert à toute personne intéressée, inscription | **1** | **active / 1 carte** |
| e-Nov 2026 — 32268142 | Le Port, 97420 | 13/11/2026, 08:00–18:00 | Conférences/tables rondes sur les enjeux du numérique en santé, inscription | **1** | **active / 1 carte** |
| Miroirs indianocéaniques — 43961004 | Saint-Denis, 97400 | Timings 01/09/2026–29/08/2027 ; 306 encore utiles au 28/10 | Projet photographique multi-sites ; texte et créneaux décrivent des périmètres/dates différents | **306** | **review / 0 carte** |
| Rencontres de l’Innovation Énergétique — 38318793 | Saint-Leu, code postal absent | 28–30/10/2026, 08:30–17:00 | Transition énergétique, hackathon/rencontres ; accès à confirmer | **3** | **review / 0 carte** |

Sources de publication retenues : Bicentenaire, CINOR, PUI VALIOTECH, GCS TESIS pour les quatre cartes ; Innovons pour le dossier énergétique en review. L’OTI Nord relaie certains contenus CINOR mais n’est pas une source d’ingestion de cette V1.

La mise en revue utilise la confiance par champ et une preuve explicative, déjà prises en charge par Mnoria : `startsAt` pour le projet photographique, `postalCode` pour la rencontre énergétique. Elle survit à la revalidation du persister et au replay. Aucun statut n’est imposé artificiellement à la base et aucun créneau source n’est réécrit.

## 5. Déduplication : défaut supplémentaire découvert et corrigé

La validation initiale sur un seul créneau donnait 5 MATCH sur 5. En testant **tous les créneaux**, le comparateur fusionnait des séances distinctes d’un événement OpenAgenda sur leur UID/URL d’événement partagés : Maison Carrère passait de **93 à 47 activités** dans la simulation.

Correction limitée dans le comparateur existant : si le même UID `openagenda-event` porte une identité `openagenda-occurrence`, deux intervalles structurés différents sont DISTINCT. Les occurrences identiques relayées continuent à matcher. Aucun second moteur n’a été créé ; la règle n’intervient pas dans les comparaisons sans cette identité OpenAgenda.

Après correction, persistance en mémoire de l’intégralité des créneaux utiles des cinq paires, puis replay :

| Événement | Activités distinctes conservées | Provenances |
|---|---:|---:|
| Ter’Eco | 2 | 4 |
| Maison Carrère | 93 | 186 |
| Ambition Planète | 2 | 4 |
| Collecte solidaire | 2 | 4 |
| CONNECT’PUI | 1 | 2 |

**100 occurrences distinctes et 200 provenances** au total, sans nouvelle activité ou provenance au replay. Les cinq paires ont toujours un MATCH sur chaque intervalle commun. Ces contrôles de relais utilisent les archives publiques ; ils n’ajoutent pas ces agendas ou ces événements au lot éditorial V1.

Le replay du lot V1 conserve exactement 536 activités, 536 provenances, 1 079 IDs externes et les quatre mêmes cartes, sans réécriture des payloads inchangés. Cette étape ne répare aucune association historique éventuellement déjà fusionnée dans le catalogue Senlis.

## 6. Les 13 cas géographiques, sans réécriture de code postal

L’analyse précise corrige un raccourci de l’audit : **97743 et 97863 sont des codes CEDEX réunionnais utilisés par des institutions**, et ne sont pas nécessairement des erreurs. Le zonage actuel les refuse car ils ne figurent pas dans les 37 codes ordinaires et ne commencent pas par 974. [Exemple institutionnel 97743 à Saint-Denis](https://choisirleservicepublic.gouv.fr/offre-emploi/medecin-de-l-ducation-nationale-sur-mission-specifique-hf-reference-MENJ-28-2026-44625/), [annuaire public 97863 à Saint-Paul](https://lannuaire.service-public.gouv.fr/la-reunion/la-reunion/f5967134-e0a7-4293-9f98-8d80a210c4e9).

Le référentiel ordinaire reconnaît bien les 24 communes et 37 codes. Sa couverture de ces CEDEX est incomplète. Cela ne change pas le diagnostic DATAtourisme : la source était déjà vide.

| UID | Commune source | Postal source | Autres éléments disponibles | Conclusion |
|---:|---|---|---|---|
| 54359988 | Saint-Leu | 98230 | Adresse « 97424 Saint-Leu », coordonnées locales | Contradiction postal/adresse ; résolution possible depuis le code explicitement présent dans l’adresse, après contrôle générique |
| 30480935 | Saint-Leu | 98230 | Même adresse/coordonnées | Même conclusion |
| 6775330 | Saint-Denis | 97743 | Adresse « 97490 Saint-Denis », coordonnées locales | CEDEX ; commune fiable, garder le code brut |
| 34619149 | Saint-Denis | 97743 | Même adresse/coordonnées | Même conclusion |
| 2690930 | Saint-Paul | 97863 | Adresse « 97460 Saint-Paul », coordonnées locales | CEDEX ; commune fiable, garder le code brut |
| 61759860 | Saint-Paul | 97863 | Même adresse/coordonnées | Même conclusion |
| 88666727 | Saint-Paul | 97863 | Même adresse/coordonnées | Même conclusion |
| 751211 | Saint-Paul | 97863 | Adresse « 97460 Saint-Paul », coordonnées locales | Même conclusion |
| 39241840 | Saint-Paul | 97863 | Même adresse/coordonnées | Même conclusion |
| 85432791 | BERRE L’ÉTANG | absent | INSEE 97415 et coordonnées Saint-Paul, mais événement en ligne | Contradiction de commune ; aucune résolution automatique fiable |
| 57908406 | BERRE L’ÉTANG | absent | Même contradiction | Même conclusion |
| 38318793 | Saint-Leu | absent | INSEE 97413, ville et coordonnées concordantes ; adresse « Saint-Leu » | Commune/département fiables ; aucun des codes postaux multiples ne peut être choisi sur ce seul référentiel |
| 66169754 | Saint-Denis | absent | INSEE 97411, adresse « Saint-Denis 97400, La Réunion », coordonnées concordantes | Code postal déjà explicite dans l’adresse, candidat à une résolution générique ; reste rejeté éditorialement |

Aucun des 13 n’a reçu un code postal inventé ou un mapping manuel.

Proposition générique, non implémentée ici : séparer l’identité géographique (INSEE/commune/département validés) du code postal brut ; résoudre les informations concordantes via le référentiel, et conserver les preuves. Pour une adresse contenant un unique code valide correspondant à la commune, une résolution générique est possible. Pour l’absence totale de code, reconnaître le département via un INSEE cohérent évite de fabriquer un postal ; cela nécessiterait de faire porter cette identité jusqu’aux sélections SQL et au filtre Explorer. Le référentiel actuel contient les correspondances nominales, pas des contours communaux permettant un point-dans-polygone. Ce chantier transversal est documenté, pas appliqué à la V1. La rencontre énergétique reste en review.

## 7. Métadonnées conservées sans migration

Chaque item du connecteur porte maintenant un `sourcePayload` versionné `openagenda-occurrence-v1` :

- UID d’événement, agenda UID, créneau source exact ;
- métadonnées d’événement hors `timings[]` : catégories/types/thèmes/champs additionnels et leurs valeurs, keywords, descriptions courte et longue, conditions, publics, organisateurs additionnels, lieux structurés, statut et mode de participation ;
- URL canonique, producteur/origine et agendas de relais, droits/licence, crédits d’image et dates de mise à jour ;
- schéma de choix additionnels si fourni : codes, types, labels et options, sans recopier tout le formulaire standard ;
- décision éditoriale explicite du pilote.

`shortDescription` évite que la description courte soit retirée par le sanitizer générique ; `longDescription` est également conservée. Les tests démontrent le contenu réellement stocké dans `provenances.source_payload` en mémoire, pas seulement la sortie du connecteur. La persistance actualise aussi ces métadonnées OpenAgenda quand le hash métier est inchangé, sur le même chemin déjà utilisé pour le payload temporel DATAtourisme. Aucune migration n’est nécessaire pour cette colonne existante.

Informations observées par producteur :

| Producteur | Métadonnées utiles disponibles |
|---|---|
| Bicentenaire | `types-devenement` (exposition), `type-de-public`, descriptions des composantes et périodes, droits/crédits |
| CINOR | `thematique`, `structure-dorigine`, mots-clés, descriptions et inscription |
| PUI VALIOTECH | Descriptions longues, publics annoncés, liens d’inscription ; pas de genre canonique commun imposé |
| Innovons | Descriptions, conditions d’accès, lieux/INSEE, inscriptions ; pas de catégorie structurée homogène sur les événements lus |
| GCS TESIS | Keywords e-santé/cybersécurité/innovation, description longue et inscription |

Les valeurs labellisées sont lues correctement même quand `status` ou `attendanceMode` deviennent des objets `{id,label}`. Une valeur numérique additionnelle reste contextualisée par l’agenda/schéma ; aucune taxonomie Mnoria n’a été construite et les colonnes `category`/`subcategory` ne sont pas remplies.

## 8. Tests, sécurité et Git

Tests ciblés : futur, mono-créneau en cours, terminé, fin exacte, multi-créneaux, plus de 20 et 600 occurrences, lots bornés/pagination, postal valide ou absent sans invention, métadonnées persistées et rafraîchies, review réellement masquée, rejeu, cinq relais réels complets, distinction matin/après-midi, longues séries via le vrai Explorer, panne de lot sans publication du staging.

Le résultat définitif de la suite et l’état Git sont consignés après la dernière vérification dans le récapitulatif ci-dessous. Les tests de données réelles utilisent une fixture archivée et ne font aucun appel réseau. Le test du vrai Explorer utilise le dépôt applicatif voisin ou `MNORIA_APP_ROOT` ; il a été exécuté ici, sans skip.

Contrôles supplémentaires : syntaxe JavaScript, JSON de fixture, `git diff --check`, recherche des valeurs de secrets `.env` dans les fichiers ajoutés/modifiés. Le package de ce dépôt ne définit pas de commande `verify:safe` : aucun serveur ou planificateur n’a été lancé pour remplacer cette vérification.

Fichiers fonctionnels :

- `sortir/connectors/openagenda-json.js` ;
- `sortir/activity-deduplication.js` ;
- `sortir/supabase-persistence.js` ;
- `sortir/openagenda-reunion-v1.js` (nouveau, sélection inactive) ;
- `sortir/openagenda-batch-persister.js` (nouveau, adaptateur manuel).

Tests/preuves : `sortir/test-openagenda-json.js`, `sortir/test-supabase-persistence.js`, `sortir/test-helpers/memory-store.js`, `sortir/test-openagenda-v1.js`, `sortir/test-openagenda-reunion-v1.js`, `sortir/fixtures/openagenda-reunion-v1-archived.json`, ce rapport.

Harnais temporaire et preuves détaillées : `/tmp/oa-reunion-audit/dry-run-v1.cjs`, `v1-dry-run-result.json`, `v1-geo-analysis.json`, journaux des tests. La fixture versionnable permet de reproduire le dry-run sans dépendre de ces fichiers temporaires.

Aucun scheduler, serveur de production, scan/ingestion DATAtourisme, backfill, migration, écriture Supabase, commit, push ou déploiement. Les modifications locales sont laissées à la revue.

### Récapitulatif définitif

- Suite finale après correction du comparateur : **41 scripts, zéro échec** ; exécution avec réseau réel bloqué.
- Scénarios ciblés V1 : **17 tests, 17 réussites, zéro skip**, dont le vrai Explorer local. Les 22 tests historiques OpenAgenda passent également.
- Rejeu intégral du dry-run : mêmes activités, provenances, IDs et cartes ; cinq relais complets validés.
- Syntaxe JavaScript et JSON : OK. `git diff --check` : OK. Aucun secret `.env` retrouvé dans les fichiers ajoutés/modifiés.
- HEAD final : **34a906a89724976257c507d51679298b4e950897**, identique au départ. Cinq fichiers suivis modifiés et sept nouveaux fichiers (dont ce rapport), tous liés à cette préparation. Aucune modification antérieure d’une autre session à retirer ; aucune suppression de travail extérieur.

**PRÊT POUR PETITE INGESTION RÉUNION : OUI — quatre événements actifs, deux dossiers en revue, sous le périmètre manuel préparé. Arrêt avant toute écriture Supabase, ingestion réelle, commit ou push.**
