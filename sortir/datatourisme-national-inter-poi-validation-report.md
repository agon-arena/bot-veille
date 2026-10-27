# Validation nationale inter-POI — arrêt contrôlé du 24 octobre 2026

Verdict B : conflit entre le statut de validation NEEDS_REVIEW et un MATCH événementiel démontré. Le scan reste arrêté ; aucune reprise supplémentaire ni réparation dans cette phase d’audit.

## Point durable

Scan `384c3c2f-649f-482f-a3dd-9431e6e163fc`, checkpoint `failed`, 40 pages / 4 000 POI acquittés. Pages 41–50 archivées, 1 000 POI pending non acquittés ; horloge conservée `2026-10-24T05:25:41.028Z`. Aucune finalisation nationale.

Le rejeu des pages 31–40 a exactement confirmé son dry-run : 990 NEW, 10 invalides, 1 343 occurrences couvertes, 990 empreintes validées ; +973 activités, +973 provenances, +2 919 external IDs. Les 370 provenances auparavant persistées ont gardé leurs liens. Le lot suivant compte hors ligne 996 calculables, 4 invalides et 1 266 occurrences sélectionnées ; aucune nouvelle empreinte de ce lot n’a été validée.

## Cause démontrée

POI `1179c639-b62b-3efd-9dc2-8148cb2f1f40`, « Le vol du cœur d’Anne de Bretagne », 1 novembre 2026, 11:00–19:00 Europe/Paris = 10:00–18:00 UTC.

Activité existante `5807d6cf-687d-4032-b739-d8a5c476cab4` : mêmes titre, description, adresse, commune, coordonnées et intervalle. Organisateur : URL `http://www.breizh-odyssee.bzh/`, nom absent des deux côtés.

Deux niveaux sont impliqués :

1. Le processus lancé avait chargé l’ancienne variante de la règle inter-POI, qui pouvait traiter des organisateurs sans nom comme une contradiction. Le code présent sur disque et son test distinguent désormais absence de nom et contradiction de noms connus.
2. Même avec cette règle corrigée, une reproduction en mémoire complète donne un MATCH du dédoublonneur mais une création REVIEW dans la persistance : `sortir/supabase-persistence.js` ne recherche un MATCH que lorsque `validation.status === "VALID"`. Ici, le seul avertissement est `organizer_name_missing`, donc NEEDS_REVIEW. La garde `guardExactSignatureReview` refuse alors la création avant INSERT. Reproduction : zéro activité/provenance créée.

Ce second problème subsiste et nécessite une correction ciblée avant reprise. Recommandation : distinguer qualité éditoriale et identité ; permettre seulement les MATCH fortement démontrés malgré un avertissement non identitaire, conserver le statut review et toutes les protections temporelles. Ne pas généraliser sans tests aux erreurs/avertissements temporels ou identitaires. Aucun assouplissement de cette barrière n’a été effectué ici.

## Mesures de la reprise Oct24 uniquement

10 pages archivées rejouées + 10 pages suivantes reçues ; 10 appels DATAtourisme, collecte HTTP 4,58 s. Durée totale 31 min 31 s, persistance 29 min 20 s. 6 142 requêtes Supabase : 214 lectures, 5 928 écritures/RPC (pas autant de lignes nouvelles). RSS maximal 403,1 Mio. Cache maximal 5 892 lignes / 14,2 Mo décimaux, 4 426 candidats chargés.

1 726 occurrences dans les sous-lots terminés ; 99 écritures d’occurrences supplémentaires avant l’arrêt du sous-lot suivant. Ne pas assimiler ce compteur aux seules créations : le rejeu réutilise aussi 370 provenances déjà présentes.

| Table | Avant reprise Oct24 | Après arrêt | Delta |
|---|---:|---:|---:|
| activités | 6 333 | 7 788 | +1 455 |
| provenances | 6 588 | 8 043 | +1 455 |
| external IDs | 19 715 | 24 080 | +4 365 |
| états POI | 4 026 | 5 026 | +1 000 observés |
| collection items | 9 914 | 11 640 | +1 726 |

Le lot 41–50 a ajouté 482 activités/provenances et 1 446 IDs avant la garde. L’état du POI bloquant garde une empreinte NULL. Les 4 000 empreintes non nulles cumulées ne comprennent aucune référence prématurée pour le pending 41–50.

## Audit après arrêt

Snapshot complet réel strictement en lecture seule : zéro orphelin, zéro doublon de clé provenance/external ID ; zéro groupe de signatures actives/review dupliquées, zéro activité active/review sans provenance active ; aucun run running. 96 activités multisources préservées, aucun changement de leurs intervalles ni perte de soutien. Provenances et IDs des autres sources inchangés. Audit de 5 862 provenances DATAtourisme actives : seule l’exception réservée « Lever du soleil sur le Causse Méjean », strictement inchangée. Couverture des 1 343 occurrences du dernier lot acquitté vérifiée sans erreur.

Anomalies source isolées : fins avant débuts et, dans le lot 31–40, heure DST ambiguë pour Moustik Festival. Elles restent observées et retentables sans empreinte validée ni réconciliation destructive.

## Tests / Git / limites

Suite complète : 554 vérifications, 34 scripts, zéro échec ; `git diff --check` propre. HEAD `75299c3`. Travail non committé conservé, dont modifications antérieures et fichiers YouTube sans rapport. Aucun commit/push. Aucun scheduler, OpenAgenda ou plafond de production modifié. Aucun deuxième scan national ni finalisation déclenchés. Pas de refonte de performance.

Preuves détaillées locales : `/private/tmp/dt-inter-poi-resume-20261024/` : `stopped-rows.json`, `stopped.json`, `integrity-stopped.json`, `conflict-audit.json`, `reproduced-conflict.json`, `tests.json`, et `national/` (archives, journal des requêtes, checkpoint, mesures et preuve d’acquittement).
