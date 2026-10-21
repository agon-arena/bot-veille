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
Les périodes identiques sont dédupliquées avant la sélection décrite ci-dessous.
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

## Sélection des occurrences (fenêtre glissante)

`takesPlaceAt` n'est pas trié par l'API : la sélection n'en dépend jamais. Pour chaque POI,
avec `options.now` comme référence (à défaut `fetchedAt`) :

1. préfiltre brut sur les dates civiles, avant Temporal, avec un jour de marge de fuseau :
   période terminée avant J−1, ou commençant après J+90+1, jamais convertie ;
2. conversion Temporal ; une période sans `startDate` ou rejetée reste une erreur isolée ;
3. déduplication par la clé temporelle `uuid + début + fin` ;
4. occurrences visibles uniquement (à venir, ou commencées et pas encore terminées) ;
5. tri par début, fin (inconnue en dernier), puis clé ;
6. fenêtre de 90 jours sur le début, plafond de 30 ;
7. si la fenêtre est vide : la seule prochaine occurrence future (seul le premier jour civil
   au-delà de la fenêtre, plus un jour de marge, est converti pour la trouver).

`fetchDatatourismeEvents` renvoie `occurrenceStats` (périodes passées, hors fenêtre, doublons,
invalides, POI plafonnés, occurrences produites), repris par le scheduler dans
`occurrenceSelection` de chaque lot. Les occurrences déjà stockées qui sortent de la sélection
suivent le vieillissement normal (`applyDisappearances`) et sont réactivées si elles reviennent.

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
