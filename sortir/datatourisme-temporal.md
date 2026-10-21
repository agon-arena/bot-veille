# DATAtourisme : identité et traçabilité temporelles

Correction locale des défauts du pipeline. Aucune reprise du stock ni ingestion réelle.
Les périodes structurées restent la référence ; aucune déduction depuis titre/description.

## Fuseaux

Les identifiants sont ceux de la [base IANA](https://data.iana.org/time-zones/tzdb/zone.tab).

| Code | Fuseau |
| --- | --- |
| 971 | America/Guadeloupe |
| 972 | America/Martinique |
| 973 | America/Cayenne |
| 974 | Indian/Reunion |
| 975 | America/Miquelon |
| 976 | Indian/Mayotte |
| 977 | America/St_Barthelemy |
| 978 | America/Marigot |
| 986 | Pacific/Wallis |
| 987 | Pacific/Tahiti, Pacific/Marquesas ou Pacific/Gambier selon la commune |
| 988 | Pacific/Noumea |

Pour 987, utiliser les codes commune COG, jamais les codes postaux : 98718, 98723,
98731, 98746, 98756, 98757 pour les Marquises ; 98719 pour Gambier ; autres communes
COG 98711–98758 pour Tahiti. Sans commune connue ni timezone explicite, signaler
l'impossibilité de choisir un fuseau au lieu de supposer Paris ou Tahiti.
Source : [codification INSEE](https://www.insee.fr/fr/information/7929495).
Un timezone explicite valide de période, POI ou localisation reste prioritaire.

Node 22 ne fournit pas Temporal natif : `@js-temporal/polyfill` remplace le calcul
manuel d'offset. La politique `disambiguation: reject` signale les heures civiles
inexistantes ou ambiguës dans les résultats d'erreur du connecteur, sans inventer
un instant. Les erreurs suivent le traitement normal du pipeline (pas de validation
réussie du chunk ni d'avancement du curseur pour une erreur de mapping).

## Identité minimale et compatibilité

Nouvelle clé : `datatourisme:{uuid}:{début UTC}:end={fin UTC ou unknown}`.
Elle ne dépend ni de l'index d'une période, ni de l'ordre du POI, ni du titre/texte.
Les périodes identiques sont dédupliquées après sélection du lot de périodes ;
la limite de 20 et l'ordre de sélection existants sont conservés.
Deux périodes du même POI commençant au même instant mais finissant différemment
sont DISTINCT même si les identifiants de POI et URL sont communs.

`source_record_id` garde l'ancien préfixe `datatourisme:{uuid}:{début UTC}` pour
préserver les correspondances existantes et les refus par UUID.
Les nouvelles et anciennes clés `source_occurrence_key` sont préchargées ensemble.
Une ancienne provenance est réutilisée uniquement lorsque sa fin canonique stockée
correspond à celle de la période entrante. Sa clé historique reste en place ;
aucune migration ni modification du stock n'est nécessaire au déploiement.
Une fin différente reste une autre période, jamais une fin écrasée par fusion.

Pour Thierry Carrier, une ancienne activité à fin 18h est réutilisée pour la
période finissant à 18h, même si son ancien payload de provenance indique 20h30.
La période finissant à 20h30 devient une activité distincte lors d'une future
ingestion. L'ordre inverse et le rejeu ne créent aucune copie supplémentaire.
Cette règle n'est pas un nettoyage des 518 écarts historiques de l'audit.

## Provenance

`source_payload` contient `version: datatourisme-period-v2`, UUID/URI/identifiant
producteur, le fragment `period`, le contexte du fuseau (commune, département et
éventuels timezones explicites), et `normalized: { startsAt, endsAt, timezone }`.
Le POI complet, les autres périodes, images et descriptions ne sont pas dupliqués.
Le payload est conservé à côté de l'activité ; les informations purement brutes
ne changent pas le hash métier. Si seul le brut change, seule sa provenance est
rafraîchie, sans réécrire les champs métier. Aucun backfill de traces inventées.

## Vérification

Fixtures minimales issues du relevé API en lecture seule du 21 octobre 2026 :
Thierry Carrier (périodes 14h→20h30 et 14h→18h), Koné, La Foa, Atelier créatif.
La contradiction source de l'Atelier (29 contre texte du 30) est volontairement
préservée. Les tests utilisent un MemoryStore et bloquent le réseau réel.
