# Validation intermédiaire après correction crs — 22 octobre 2026

**Verdict B : pagination corrigée, mais incohérence métier détectée après le premier passage. Deuxième passage interdit/non exécuté.**

## Correction minimale et tests

`sortir/datatourisme-national-scan.js`, fonction `nextUrl` : ajout de la seule entrée `crs` à l'allowlist. La réponse réelle observée dans `meta.next` comporte `fields`, `lang`, `page_size`, `filters`, `crs` sur la même origine et le même endpoint. Les contrôles d'origine, chemin, identifiants URL, fragment et périmètre sont inchangés.

Deux tests de régression ajoutés dans `test-datatourisme-batch-checkpoint.js` : réutilisation de la page suivante avec le curseur réel observé, API key uniquement en header et retirée du lien ; rejet des modifications d'origine/chemin/fields/lang/page_size/filters et de paramètres inconnus même en présence de crs. Aucun seuil ou règle de déduplication modifié.

**470/470 vérifications vertes avant et après le test**, 28 scripts. Les nouvelles incohérences temporelles décrites ci-dessous ne sont pas couvertes par cette suite.

## Abandon du précédent checkpoint et précontrôle

L'ancien scan `2ad47f77-982d-4afc-94e3-c56edba85ca3` a été vérifié running, sans page acquittée, sans objet observé et sans pending. Il a été explicitement abandonné via `sortir_dt_fail_national_scan`. Statut failed vérifié ensuite, sans changement des autres champs. Zéro run ingestion/source running. Coût : quatre lectures et une RPC mutante.

Dépôt initial propre hormis le rapport historique non suivi annoncé, HEAD main `75299c3`. La migration déjà installée n'a pas été réappliquée.

## Périmètre réellement exécuté

Un seul passage réel, dix pages de cent objets via le lecteur et le runner nationaux existants, checkpoint de mille, calcul de l'état, comparaison batchée, persister normal, cache candidats, réconciliation puis enregistrement des références. Aucun store simulé pour les écritures métier.

Le now logique de la tentative précédente est conservé : `2026-10-21T18:45:07.661Z`, donc même filtre national `takesPlaceAt.endDate[gte]=2026-10-21`. Les dix réponses annoncent 64 571 objets au total ; seule leur première tranche de mille a été parcourue. Aucun onzième appel ni finalisation nationale.

Limite à 1 000 imposée par dix pages et garde-fous supplémentaires. Le runner s'arrête volontairement au prochain contrôle maxPages ; ce n'est pas une certification de complétude nationale. Après acquittement du lot, le scan partiel a été explicitement abandonné.

## Mesures du premier passage

| Mesure | Résultat |
| --- | ---: |
| Pages réellement parcourues | 10 |
| POI reçus | 1 000 |
| NEW | 975 |
| CHANGED | 20 |
| UNCHANGED | 0 |
| Invalides | 5, ends_before_start |
| KEEP / DENY parmi les calculables | 874 / 121 |
| Occurrences sélectionnées/traitées | 1 293 |
| Empreintes enregistrées comme références | 995 |
| Nouvelles activités | 960 |
| Nouvelles provenances | 992 |
| Nouveaux external IDs | 3 213 |
| Provenances historiques considérées retirées | 1 432, dont 245 déjà inactives |
| Provenances effectivement désactivées | 1 187 |
| Activités passées stale | 1 153 |
| Appels DATAtourisme | 10 |
| Requêtes Supabase du runner | 4 865 |
| Lectures Supabase | 94 |
| Écritures / RPC mutantes Supabase | 4 771 |
| Collecte HTTP cumulée | 3,71 s |
| Persistance : somme des dix tranches | 1 327,91 s, soit 22 min 07,9 s |
| Durée totale du passage | 1 367,59 s, soit 22 min 47,6 s |
| Pic RSS observé par le moniteur | 247,1 Mio |
| Pic heap observé | 64,8 Mio |
| Pic du cache | 2 720 lignes ; 6 556 445 octets JSON compact |
| Candidats chargés depuis Supabase | 1 739 lignes, 12 requêtes, 4 289 723 octets |
| Candidats déjà couverts relus | 0 |

Les durées des tranches comprennent leur pipeline normal et ses préchargements ; le rafraîchissement final du cache et la réconciliation/enregistrement des états font partie de la durée totale mais ne sont pas tous compris dans la somme des tranches. Le coût réseau distingue requêtes et nombre de lignes.

Le chemin a signalé les 995 références enregistrées avec succès ; **le contrôle métier externe invalide cette conclusion pour au moins le cas détaillé ci-dessous**. Ces empreintes ne doivent pas servir à considérer automatiquement les cas concernés comme sains/UNCHANGED sans correction et retraitement ciblé.

Coût hors runner : cinq requêtes pour l'abandon préalable, 42 lectures pour le snapshot initial et 56 pour le snapshot après passage. Total instrumenté de cette étape : 4 968 requêtes REST Supabase = 196 lectures + 4 772 requêtes mutantes. Aucun appel de diagnostic supplémentaire à l'API : dix appels DATAtourisme au total. Pas de trafic SQL editor dans cette étape.

## Surveillance par tranche

| Tranche | POI à persister | Occurrences | Durée s | RSS fin Mio | Candidats chargés |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 100 | 115 | 117.46 | 229.2 | 1168 |
| 2 | 100 | 129 | 132.72 | 118.9 | 270 |
| 3 | 100 | 160 | 160.20 | 116.8 | 86 |
| 4 | 100 | 104 | 105.09 | 133.6 | 69 |
| 5 | 100 | 148 | 148.82 | 125.1 | 50 |
| 6 | 100 | 138 | 140.67 | 137.9 | 19 |
| 7 | 100 | 121 | 123.57 | 143.4 | 37 |
| 8 | 100 | 152 | 156.93 | 134.5 | 23 |
| 9 | 100 | 128 | 138.20 | 136.4 | 2 |
| 10 | 95 | 98 | 104.25 | 143.7 | 15 |

La mémoire est redescendue après les premiers pics ; ni le seuil de 700 Mio ni le garde-fou de croissance continue n'ont été déclenchés. Les lectures candidates diminuent après le chargement initial et aucun identifiant de candidat chargé par fenêtre n'a été relu. Les 1 270 lignes rafraîchies après mutation sont une catégorie distincte et explicitement prévue par le cache.

## État DB avant/après

| Table | Avant | Après premier passage |
| --- | ---: | ---: |
| Activités | 2323 | 3283 |
| Provenances | 2539 | 3531 |
| External IDs | 7220 | 10433 |
| États POI | 20 | 1000 |
| Runs ingestion | 73 | 83 |
| Runs source | 104 | 114 |
| Collection items | 5049 | 6342 |
| Décisions de déduplication | 3 | 3 |

Statuts : active 1 024 → 941 ; review 1 017 → 907 ; stale 278 → 1 431 ; merged 4 → 4. Ces compteurs ne prouvent pas à eux seuls la justesse des désactivations.

Intégrité structurelle : zéro doublon de clé provenance/external ID, zéro référence orpheline, zéro run ingestion/source running. Les quatre activités sans provenance sont les quatre activités merged déjà présentes. Zéro activité active/review sans soutien actif. Les deux signatures répétées titre/dates/ville étaient présentes avant et sont inchangées.

Les 96 activités multisources ont les mêmes identités avant/après ; les activités soutenues par une autre source restent active/review. Les provenances des autres sources et des POI invalides sont strictement conservées. Le contrôle des empreintes contre l'état calculé passe, mais ne détecte pas l'écart avec les occurrences effectivement représentées.

## Nouvelle anomalie métier — arrêt obligatoire

Le contrôle complet des occurrences sélectionnées échoue : **une occurrence attendue n'a plus de provenance active correspondante**. Le test a été arrêté au contrôle d'intégrité. Aucun second passage, correctif métier ou écriture de réparation après ce constat.

Cas démontré : POI `038cc76c-3c2f-34c4-a7c4-ea7982a00787`, le 29/10/2026 :

- sélection attendue : créneau **08:30–09:30 UTC**, ainsi que **13:30–14:30 UTC** ;
- avant test : l'activité `5c385977-5ea5-461c-9585-5927afd83e85` porte 08:30–09:30, la provenance matin `16affb36-9133-4588-8e23-14db46f6aa4f` est active ;
- après test : la même activité porte 13:30–14:30 et la provenance matin est inactive ; aucune provenance canonique active ne représente le créneau matin sélectionné ;
- l'empreinte de ce POI a pourtant été enregistrée et needs_reprocess=false.

Reproduction en mémoire sur le snapshot : `compareActivities(activité matin avant test, occurrence après-midi)` renvoie MATCH avec un décalage de cinq heures, car l'URL d'origine partagée suffit à l'identité et le conflit temporel général ne s'applique qu'au-delà de douze heures. Le cas spécial DATAtourisme actuel couvre le même début avec fins différentes, mais pas ces deux créneaux distincts du même POI.

La fusion déplace ensuite la fin de l'activité. La réconciliation refuse alors l'alias legacy du matin, qui exige la même fin d'activité, et désactive la provenance. Le contrôle ne vérifie pas qu'une provenance actuelle la remplace avant d'acquitter l'état.

Cela n'est pas provoqué par l'ajout de crs : le validateur de pagination ne touche pas aux règles de fusion. Le lot réel plus large expose un défaut du traitement des occurrences.

L'audit temporel local exhaustif relève **25 signalements sur 21 POI** : le cas manquant/inactif ci-dessus et 24 écarts de plus de cinq minutes entre les horaires de provenance attendus et l'activité liée. Trois de ces écarts d'activité étaient déjà visibles avant ce passage. Ces 24 écarts demandent une revue de la sémantique de fusion, et ne sont pas tous assimilés automatiquement à de nouvelles suppressions.

Il faudra corriger/tester la séparation des créneaux DATAtourisme et le contrôle de couverture avant validation des références, puis prévoir une réparation/reprise ciblée des données et références concernées. La liste des 21 UUID est disponible dans les artefacts. **Aucune empreinte n'a été invalidée ni aucune donnée réparée automatiquement**, conformément à l'arrêt demandé.

## Checkpoint final et second passage

Ancien checkpoint abandonné : `2ad47f77-982d-4afc-94e3-c56edba85ca3`.
Nouveau scan : `48f740d7-63cc-4cd3-a136-b0b66b2c232f`.

État final : failed après abandon contrôlé du scan partiel, pages=10, received=1000, total=64571, pending=null ; URL suivante conservée, last_finalized_id=null. Aucun checkpoint running/complete actif, aucune finalisation globale, aucune progression d'absence nationale.

Le second passage identique est **non exécuté** : son autorisation était conditionnée à une intégrité saine. Un résultat UNCHANGED fondé sur les références déjà enregistrées pourrait masquer le défaut ; il ne constituerait pas une validation d'idempotence métier.

## Git et livrables

HEAD `75299c3`, main. Deux fichiers suivis modifiés : ajout de crs au validateur et deux tests. Nouveau rapport : ce document. Le rapport historique `datatourisme-intermediate-validation-report.md` reste non suivi et inchangé (SHA-256 `5b57177d530e1a1558d089bf04fac596e2e318af40a7cdc4c7bdccd112cb2ec2`).

Aucun scheduler, plafond 300 de production ou OpenAgenda modifié. Aucun scan de plus de mille POI, aucun commit/push. Pas de réparation automatique ni de reprise après l'anomalie.

Artefacts locaux : `/private/tmp/dt-intermediate-crs-validation/` : lot exact et dix pages, snapshots avant/après, requêtes sans secrets, progression, mémoire, anomalies, preuve de reproduction du MATCH et abandon du checkpoint. Les fixtures sont conservées pour la correction suivante ; elles ne sont pas publiées.
