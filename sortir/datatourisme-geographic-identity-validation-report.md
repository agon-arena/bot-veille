# Noël au château — audit géographique et validation

## Audit initial strictement en lecture seule

**Verdict final B : Noël au château résolu et validé ; nouvel arrêt sur un programme regroupant des ateliers distincts. National non terminé.**

Identité du même événement déclarée et corroborée par le site de son exploitant. La divergence GPS n’est pas une preuve de deux événements. Aucune assertion que les deux coordonnées désignent deux entrées du domaine ; aucun recalage de données métier.

| Champ | Fiche déjà persistée | Fiche reçue |
|---|---|---|
| UUID | `0e898107-1fb2-3a07-8cc1-f1a7b4724159` | `25b6bd21-f624-3fc9-a873-8cc819ae6161` |
| Producteur | `FMANOR014V567ZFM` | `FMANOR014V54P4CE` |
| URI | https://data.datatourisme.fr/30/311517db-c20b-385c-8c97-adc0e9d9e82f | https://data.datatourisme.fr/30/9f30224c-cd7a-3cc3-a7fe-cdf5922d0a57 |
| Titre | Noël au château | identique |
| Description complète et courte | voir ci-dessous et fixture | strictement identiques |
| Contact normalisé | nom NULL, https://www.chateaudecanon.com/ | identique |
| Organisateur source explicite | absent, contact utilisé selon le connecteur existant | identique |
| Rue | Avenue du château | identique |
| Commune / INSEE | Mézidon Vallée d’Auge / 14431 | identique |
| Code postal / pays | 14270 / France (FR) | identique |
| Département / région | Calvados 14 / Normandie 28 | identiques |
| venue_name | NULL | NULL |
| Latitude / longitude | 49.0780719 / -0.0914689 | 49.07323 / -0.07877 |
| Distance calculée | 1 070 m | |
| Périodes | 19–31 décembre 2026, 14:00–19:00 | identique + 18–31 décembre 2027, 14:00–19:00 |
| Sélection actuelle | période 2026 seulement | période 2026 seulement |
| Intervalle normalisé | 2026-12-19T13:00:00.000Z → 2026-12-31T18:00:00.000Z | identique |
| Fuseau | Europe/Paris, détermination territoriale | identique |
| Visuel | Encart-noel-2025.jpg | Encart-insta-noel-2026.jpg |
| Crédit | Château de Canon | identique |
| Thèmes | ArchitectureAndHeritage, Christmas | identiques |
| Types | PointOfInterest, CulturalEvent, Product, ChildrensEvent, ShowEvent, Event, Visit, EntertainmentAndEvent | même ensemble, ordre différent |

Les openingHoursSpecification correspondent à chaque période brute ; la fiche reçue ajoute uniquement la représentation 2027 hors sélection. Aucun téléphone, e-mail, numéro de rue ou nom de lieu dédié n’est présent dans ces payloads. Pas d’autre propriété discriminante dans les champs téléchargés ; les champs non téléchargés ne sont pas réputés vérifiés. La période longue existante n’a pas été découpée ni réinterprétée ; les jours particuliers annoncés sur le site ne sont pas ajoutés au pipeline dans cette étape.

### Description complète commune, issue des archives

Noël au château, c’est l’occasion de découvrir un magnifique domaine du XVIIIe
siècle entièrement classé Monument historique constitué d’1 hectare de bâtiment...
Nombre d’entre eux sont ouverts et décorés pour l’occasion et réservent bien des
surprises aux visiteurs !
A l’approche de Noël, l’intérieur du château de Canon entièrement décoré s’ouvre à
la visite. De la salle à manger au grand salon en passant par la chambre des enfants et
les cuisines... la visite du château laisse ressurgir les émotions du Noël d’antan dans
une atmosphère festive et familiale pleine d’émerveillements !

### Sources publiques et portée de la preuve

- [Exploitant — Noël au château](https://www.chateaudecanon.com/animations/noel-au-chateau) : événement au château de Canon, période et horaires correspondant à ceux des deux fiches.
- [Exploitant — Accès](https://www.chateaudecanon.com/acces) et [contact](https://www.chateaudecanon.com/contact) : site et adresse déclarée communs. Ces pages ne prouvent pas une double entrée aux coordonnées fournies.
- [Office de tourisme — événement](https://tourisme.lisieux-normandie.fr/offres/noel-au-chateau-mezidon-vallee-dauge-fr-5206682/) : même événement, adresse et domaine web ; son itinéraire reprend le point 49.07323/-0.07877. C’est une corroboration de l’événement, pas une validation indépendante de ce point.
- [IGN géocodage inverse](https://data.geopf.fr/geocodage/reverse?lon=-0.07877&lat=49.07323&index=address&limit=1) : adresse la plus proche à 15 m, 121 avenue Jean-Jaurès ; le point n’est donc pas directement corroboré comme l’entrée du château à l’adresse déclarée. Cela suggère un géocodage imprécis, sans établir son origine.
- [IGN ancien point](https://data.geopf.fr/geocodage/reverse?lon=-0.0914689&lat=49.0780719&index=address&limit=1) : aucune adresse retournée par cette requête. Ne permet pas de qualifier parking/entrée/office.
- [API communale](https://geo.api.gouv.fr/communes/14431?fields=nom,code,centre,mairie&format=json) : centre (-0.0169,49.086), mairie (-0.0655,49.0715), aucun identique aux points source. Pas de preuve d’un centroïde communal pour l’un des deux points.

Conclusion : même événement et même lieu déclaré démontrés indépendamment des points, mais origine exacte du décalage GPS indéterminée. Aucune preuve de deux sites distincts, ni de deux entrées du même site. Le MATCH porte sur l’identité événementielle ; il ne tranche pas l’autorité géographique.

### Identités et provenance

Activité existante : `b92c639c-5b42-49ae-bf87-4007bbb7a777` ; provenance existante `03e1007c-b438-4be2-b013-693de34f6217`. Chaque fiche conserve ses trois external IDs : `datatourisme-poi` (son UUID), `datatourisme-producer-id` (son identifiant producteur), et `datatourisme-occurrence` :

- `datatourisme:0e898107-1fb2-3a07-8cc1-f1a7b4724159:2026-12-19T13:00:00.000Z:end=2026-12-31T18:00:00.000Z`
- `datatourisme:25b6bd21-f624-3fc9-a873-8cc819ae6161:2026-12-19T13:00:00.000Z:end=2026-12-31T18:00:00.000Z`

Source record IDs : même préfixe jusqu’au début, sans suffixe `:end=...`. Pas de fusion des identités de source ou des périodes 2026/2027.

## Règle générale prudente

Version de dédoublonnage `sortir-dedup-v3`. Uniquement pour des UUID DATAtourisme distincts : une contradiction de coordonnées peut être résolue pour l’identité si intervalle exact avec fin et heures explicites, même fuseau, titre normalisé exact, description normalisée exacte et substantielle (au moins 12 mots de chaque côté), rue/commune/code postal/pays complets et identiques, venue_name identique (y compris absent des deux côtés), contact URL commun, et aucune autre contradiction.

Les autres protections restent inchangées ; des textes simplement similaires ne qualifient pas. Aucun nouveau rayon de tolérance de 1 070 m. Le signal de distance et un signal spécifique `datatourisme_coordinate_conflict_exact_identity` restent tracés. En cas de MATCH par cette preuve, les coordonnées de l’activité gagnante sont conservées ; les deux valeurs GPS sont inscrites dans ses preuves de conflit. Cela n’est pas une correction géographique automatique, ni une garantie sur l’autorité du point conservé.

## Tests et dry-run

565 vérifications / 34 scripts réussis, zéro échec ; `git diff --check` propre. Couverture : identité exacte malgré coordonnées divergentes (distances variées, pas de nouveau rayon), rues/communes/postaux/pays/lieux contradictoires, descriptions seulement similaires, contact absent, fuseau contradictoire, horaires distincts, Noël archivé et rejeu ; Anne de Bretagne, Singulières et protections multi-sessions conservés.

Dry-run du pending 91–100 à l’horloge durable `2026-10-25T04:25:51.603Z` : 991 NEW, 9 invalides, 1 246 occurrences couvertes, zéro blocage ; +685 activités, +688 provenances, +2 064 IDs ; 3 MATCH, aucun retrait/stale. Les 558 provenances déjà persistées restent uniques et gardent leur activité, dont les liens des 557 collection items antérieurs. Rejeu mémoire : 991 UNCHANGED / 9 invalides, zéro persistance métier. Aucun état réel n’a été modifié pendant ces simulations.

Snapshot réel strictement identique au précédent arrêt : 14 023 activités / 14 282 provenances / 42 797 IDs / 10 026 états, aucun run running, aucun doublon/orphelin, 96 multisources. Précontrôle : 12 101 provenances DATAtourisme actives, seule exception Lever du soleil strictement inchangée. Curseur101 vérifié en lecture seule, total62 940 stable. Reprise verrouillée autorisée et en cours ; les résultats finaux seront ajoutés après arrêt ou terminaison. Aucun verdict de réussite nationale à ce stade.

Archives brutes intégrales : [fixture géographique](fixtures/datatourisme-geographic-identity-archived.json). Preuves publiques, snapshots et dry-runs : `/private/tmp/dt-geo-identity-validation/`. Aucun scheduler/OpenAgenda/commit/push.


## Validation réelle du pending 91–100

Acquittement réussi, compteur national 100 pages / 10 000 POI, 64 invalides acquittés. 991 empreintes validées après couverture 1 246/1 246. Résultat strictement égal au dry-run : +685 activités, +688 provenances, +2 064 IDs, aucun retrait/stale. Les 558 provenances préexistantes gardent leur identité et leur activité.

Activités 14 023→14 708 ; provenances 14 282→14 970 ; IDs 42 797→44 861 ; états POI inchangés à 10 026 (déjà observés). Zéro doublon/orphelin/run running, 96 multisources. Temps de traitement du lot avant audit après acquittement : 903,59 s ; 3 035 requêtes du runner à ce point (209 lectures, 2 826 écritures/RPC), snapshot indépendant de 217 lectures en plus. Pic RSS du runner 456,3 Mio à ce stade.

Contrôle réel Noël : une activité `b92c639c-5b42-49ae-bf87-4007bbb7a777`, deux provenances actives, six external IDs, intervalle inchangé, coordonnées 49.0780719/-0.0914689 conservées, preuves des deux valeurs latitude/longitude persistées. Source `25b6…` rattachée sans nouvelle activité ; état review conservé. Le store existant ignore les décisions MATCH dont les deux activity IDs sont identiques : les trois MATCH du lot ne créent donc pas trois lignes `sortir_dedup_decisions` (les deux nouvelles lignes sont des REVIEW). Les signaux de comparaison et les preuves géographiques sont des niveaux de trace différents ; les preuves GPS sont conservées dans l’activité.

La continuation a reçu les pages 101–110. Aucun verdict de terminaison nationale encore.


## Arrêt final — nouvelle classe programme / visites distinctes

Arrêt avant INSERT page 103, index zéro 3, position nationale 10 204. Titre commun « Les Semaines du Tourisme Économique et des Savoir-Faire », commune Lanvénégen, 56320, INSEE56105.

- Fiche existante `092d8ee7-e610-3a05-a105-6e305e901260`, producteur `FMABRE056V50HA3B`, activité `7522e7dd-9f8b-4cc3-8186-5937a747ef63` : description spécifique « visite de l’atelier le meuble du photographe ».
- Fiche entrante `28f6fbfd-a9fc-3e99-a0ef-da4a1fcbc5c3`, producteur `FMABRE056V50H8XI` : description spécifique « visite de l’atelier l’En verre du Décor et l’instant de verre ».
- URL commune de programme régional, pas d’adresse de rue ni venue_name. Période brute 19 octobre→1 novembre2026, sans heures explicites ; intervalle de repli date seule normalisé 18 octobre22:00Z→1 novembre22:59Z Europe/Paris (changement DST inclus).
- Les coordonnées identiques45.4587971/-94.418775 sont incompatibles avec la localisation française déclarée. La même donnée se trouve dans les deux archives ; son origine n’est pas démontrée. Ne pas déduire le même lieu d’un point identique de mauvaise qualité, ni corriger automatiquement ce point.

Le dédoublonneur retourne REVIEW, pas MATCH : descriptions non identiques, établissements nommés différents, adresse absente, heures absentes. La nouvelle résolution GPS stricte ne s’applique donc pas. La garde de signature titre/intervalle/commune bloque ensuite la création : un titre de programme et une plage globale ne constituent pas une identité suffisante de visite. Nouvelle classe à traiter avant reprise : représentation du programme vs visites de lieux distincts, ainsi que qualité des coordonnées source. Aucun changement de règle supplémentaire appliqué ; la revue reste réservée. La prochaine décision doit établir comment porter une identité de visite/lieu suffisamment discriminante et comment acheminer ces REVIEW sans assimiler une simple signature de programme à un doublon certain.

Activité existante strictement inchangée ; aucun nouvel objet pour la fiche bloquée ; empreinte NULL. Une seule activité avec ce couple GPS existait avant cette étape et reste unique après : pas de nouvelle activité créée à ces coordonnées par ce run.

### Point durable final et intégrité

Checkpoint `failed`, 100 pages /10 000 POI acquittés,64 invalides acquittés. 110 pages /11 000 POI reçus cumulés pour le scan ; catalogue annoncé62 940. Pending101–110 conservé,1 000 POI, horloge `2026-10-25T09:56:37.240Z` :991 calculables,9 invalides (fin avant début),1 300 occurrences sélectionnées ;240 couvertes sans erreur,1 060 non encore traitées. Zéro empreinte validée dans ce pending. 9 962 empreintes non nulles au total ; aucune référence antérieure modifiée.

Audit transversal des archives acquittées pages11–100 :8 941 POI calculables,11 425 occurrences sélectionnées, zéro défaut de couverture. Précontrôle de13 029 provenances DATAtourisme actives : seule exception temporelle Lever du soleil réservée, inchangée. Zéro orphelin, doublon de clés provenance/ID, activité active/review sans soutien ou groupe de signatures fonctionnelles dupliquées ; aucun run running. Les96 multisources gardent soutien et intervalle. Provenances/IDs des autres sources inchangés. L’anomalie GPS source du nouveau cas est explicitement conservée pour revue et n’est pas assimilée à une preuve d’intégrité géographique de toutes les sources.

| Compteur | Avant cette étape | Après arrêt |
|---|---:|---:|
| activités |14 023|14 947|
| provenances |14 282|15 210|
| external IDs |42 797|45 581|
| états POI |10 026|11 026|
| collection items |19 676|21 161|

Delta :924 activités,928 provenances,2 784 IDs ; aucun retrait/stale. Dont le pending interrompu :239 activités,240 provenances,720 IDs (239 occurrences dans les sous-lots terminés, une supplémentaire avant l’arrêt du sous-lot suivant). Le pending91–100 acquitté explique le reste, exactement conforme au dry-run.

Statuts finaux :active6 545,review6 663,stale1 735,merged4 ; stale/merged inchangés.

### Performances de ce lancement

2 000 réceptions (1 000 archivées91–100 +1 000 nouvelles101–110),10 appels DATAtourisme,4,78 s de collecte.23 min32,49 s de durée totale du runner,19 min29,23 s dans la persistance.4 101 requêtes Supabase du runner :284 lectures et3 817 écritures/RPC ; snapshots/précontrôles/moniteurs indépendants hors ce compteur.1 485 occurrences dans les sous-lots terminés, plus une écriture avant le dernier blocage. Quatre MATCH au total dans les sous-lots achevés ; trois dans le pending91–100 et un dans le lot suivant. Pic RSS556,4 Mio lors de l’audit après acquittement, puis descente observée vers341 Mio ; aucun seuil700 Mio franchi ni croissance continue incontrôlée. Cache maximal12 700 lignes /28,6 Mio,11 753 candidats chargés. Aucune optimisation structurelle pendant le scan.

### Tests et fichiers

Suite complète finale :**566 vérifications /34 scripts, zéro échec**. Ajout d’un contre-exemple archivé : programme commun, ateliers différents, absence d’adresse/heures et GPS identiques ne deviennent pas MATCH ; la garde empêche nouvelle activité/provenance et validation d’empreinte. Les tests Noël, Anne de Bretagne, Singulières et multi-sessions restent verts. `git diff --check` propre.

Fichiers propres à cette étape : `sortir/activity-deduplication.js`, `sortir/test-datatourisme-inter-poi.js`, `sortir/fixtures/datatourisme-geographic-identity-archived.json`, `sortir/fixtures/datatourisme-programme-visits-archived.json`, ce rapport. Tout le travail antérieur non committé est conservé. Branche main, HEAD0d17e89 ; aucun commit/push. Aucune migration appliquée dans cette étape, aucun scheduler/OpenAgenda/plafond modifié, aucune réparation générale, aucune finalisation nationale, aucun second national.

Preuves finales : `/private/tmp/dt-geo-identity-validation/` : `stopped-rows.json`, `stopped.json`, `integrity-stopped.json`, `stop-proof.json`, `noel-live-proof.json`, `national/noel-real-proof.json`, `national/pending-ack-proof.json`, `national/blocked-creation.json`, `national/new-ambiguity-evidence.json`, archives101–110 et journaux. Checkpoint non repris après ce nouveau blocage.
