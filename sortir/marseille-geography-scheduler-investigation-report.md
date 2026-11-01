# Investigation ciblée — géographie Marseille et scheduler quotidien

## Verdict

**GÉOGRAPHIE PILOTE : CORRECTION NÉCESSAIRE**

**SCHEDULER : DÉFAILLANT**

**PILOTE 75 : NON AUTORISABLE**

Investigation entièrement en lecture seule. Aucun code, plan scellé, réglage, donnée Supabase ou statut modifié ; aucun scheduler déclenché, aucune ingestion manuelle, aucun commit/push. Le run naturel du 30 octobre s’est exécuté indépendamment de cette investigation ; nous en avons uniquement lu les traces.

## 1. Cause démontrée de 13055

Les quatre activités correspondent au même POI DATAtourisme **a9b0903f-ac36-35c7-b0f2-6270941de327**, identifiant producteur **8002973**, URI **https://data.datatourisme.fr/58/7745eeac-ab5b-3c7e-b163-9ab4bc231674**.

Lecture brute du POI via GET /v1/catalog/{uuid}, à **2026-10-30T02:35:29.341Z** (06:35 Réunion) :

| Champ source | Valeur |
|---|---|
| isLocatedAt[0].address[0].postalCode | **13055** |
| hasAddressCity.insee | **13055** |
| hasAddressCity.label | Marseille |
| hasAddressCity.isPartOfDepartment.insee | 13 |
| Département / région / pays | Bouches-du-Rhône / Provence-Alpes-Côte d’Azur / France |
| latitude / longitude | **43.294924 / 5.372668** |
| streetAddress | Nombreux lieux culturels et salles de spectacles à Marseille et dans la région. |

Créateur déclaré : Office de Tourisme des Loisirs et des Congrès de Marseille. Éditeur déclaré : Provence Tourisme / Office de Tourisme des Loisirs et des Congrès de Marseille. DATAtourisme expose donc la confusion dans son champ postal ; cette preuve n’établit pas à quel étage du système du producteur la saisie initiale a eu lieu.

La fiche INSEE confirme que **13055 est le code officiel géographique de Marseille** : https://www.insee.fr/fr/metadonnees/geographie/commune/13055-marseille . La réponse de l’API géographique officielle pour la commune 13055 fournit le département 13 et les codes postaux **13001 à 13016**, sans 13055 : https://geo.api.gouv.fr/communes/13055?fields=nom,code,codesPostaux,departement,centre . DATAtourisme documente bien postalCode comme un code postal, distinct de hasAddressCity : https://api.datatourisme.fr/v1/docs?lang=fr .

### Chaîne interne vérifiée sans écrire

Rejeu local pur des fonctions existantes, sur le POI brut et les quatre périodes archivées :

**source postalCode 13055 → mapLocation.postalCode 13055 → normalizeActivity.postalCode 13055 → activityToRow.postal_code 13055 → valeur en base 13055**.

Les quatre reproductions concordent exactement, GPS compris. Le connecteur (sortir/connectors/datatourisme.js, mapLocation) lit directement address.postalCode ; il ne prend pas hasAddressCity.insee comme code postal de repli. La normalisation (activity-validation.js) retire les espaces, sans convertir l’INSEE en postal. La persistance copie postalCode vers postal_code. **Aucune transformation interne INSEE→postal n’est observée ; une valeur source erronée est propagée sans contrôle de correspondance postal/commune.**

### Ce que contient réellement source_payload

Chaque provenance est en datatourisme-period-v2 et conserve poiUuid, poiUri, producerIdentifier, la période, les dates normalisées et timezoneContext. Les quatre timezoneContext portent communeInsee=13055 et departmentInsee=13. **Le payload compact ne conserve pas l’adresse brute, son postalCode ni ses coordonnées d’origine.** Il ne permet donc pas, seul, de certifier la géographie historique du POI au jour de l’ingestion. La source actuelle, ses métadonnées de mise à jour (lastUpdate 1er octobre ; lastUpdateDatatourisme 21 octobre), les lignes en base et le rejeu du code concordent. La limite d’archive est conservée explicitement.

### GPS et absence de correction univoque

Les coordonnées sont identiques entre la source et la base et sont dans des plages numériques valides. La recherche officielle de commune par point a renvoyé un tableau vide. Le géocodage inverse IGN/BAN retourne comme entité la plus proche **Quai de la fraternité, 13001 Marseille, à 132 mètres**. Cela situe le contexte du point près du Vieux-Port ; **cela ne prouve pas que les quatre séances se déroulent à cette adresse**. Le service retourne l’entité la plus proche, pas le lieu de l’événement : https://cartes.gouv.fr/aide/fr/guides-utilisateur/utiliser-les-services-de-la-geoplateforme/geocodage/ .

La source n’a qu’une localisation technique, mais décrit plusieurs lieux et spectacles dans la région. Son programme mentionne notamment La Meson, la Cité de la Musique et La Caverne Jazz. Elle ne fournit aucun autre code postal dans ses champs géographiques. Les 16 codes de la commune et le résultat inverse ne justifient pas d’en choisir arbitrairement un. Une adresse unique fiable pour chacune des quatre occurrences n’est pas établie.

## 2. Pourquoi Explorer les rejette précisément

Le filtre SQL départemental postal_code LIKE '13%' laisse passer 13055. Le rejet intervient ensuite dans **lib/explorer-geo.js, departmentScope('13').accepts(row)** :

1. 13055 n’est pas dans les codes postaux du département ;
2. 13055 est inconnu du référentiel postal national local ;
3. le préfixe 13 est correct, mais le repli exige aussi une commune reconnue ;
4. le référentiel local contient Marseille 01 à Marseille 16, **sans commune parent Marseille / INSEE 13055**. La clé normalisée marseille n’y existe donc pas ; accepts retourne false.

Deux constats distincts : la source fournit un INSEE dans postalCode ; le référentiel Explorer ne reconnaît pas la commune parent pour son repli. Ajouter simplement 13055 comme code postal ou remplacer celui-ci par 13001 contournerait l’anomalie sans la résoudre. Le comportement de regroupement national précédemment validé ne couvrait pas ce filtre géographique.

## 3. Étendue mesurée

Projection fraîche de **78 813 activités associées à une provenance DATAtourisme**, tous statuts et horizons, lue en une requête SQL. Instant de référence des compteurs futurs/en cours : **2026-10-30 02:36:15.44792+00**.

- **77 108** ont un INSEE source exploitable dans le payload ; **1 705** n’en ont pas.
- **63** ont postal_code égal à l’INSEE source.
- **20 sont des coïncidences légitimes** : le référentiel confirme le même code comme code postal de cette commune. Elles sont exclues des anomalies.
- **43 occurrences / 15 POI / 7 communes** ont un code égal à l’INSEE source mais absent du référentiel postal. Répartition : **28 active, 15 review** ; **40 futures/en cours** (25 active, 15 review).

| Commune | Code INSEE utilisé comme postal | Occurrences | POI | active | review |
|---|---|---:|---:|---:|---:|
| Marseille | 13055 | 14 | 1 | 0 | 14 |
| Le Bugue | 24067 | 4 | 4 | 4 | 0 |
| Vaunac | 24567 | 1 | 1 | 1 | 0 |
| Saint-Pierre-de-Frugie | 24486 | 6 | 4 | 6 | 0 |
| Saint-Paul-la-Roche | 24481 | 6 | 1 | 6 | 0 |
| Saint-Priest-les-Fougères | 24489 | 11 | 3 | 11 | 0 |
| Lyon | 69123 | 1 | 1 | 0 | 1 |

Les **14 occurrences Jazz sur la ville** sont toutes REVIEW ; les quatre du pilote en sont un sous-ensemble. Le cas Lyon concerne la Biennale d’Art Contemporain de Lyon.

Vérification source ciblée des 14 autres POI : **13 réponses HTTP 200**, toutes avec le même mauvais postalCode qu’en base, et **1 HTTP 404** (Cours d’anglais et de piano, Saint-Pierre-de-Frugie, une occurrence). Avec Jazz sur la ville, cela confirme la présence du problème dans l’API actuelle pour **14 POI / 42 occurrences**. La 43e est constatée en base mais son détail source actuel n’est plus accessible. Aucune lecture/ingestion d’un catalogue national complet n’a été lancée.

Effet Explorer : les **15 occurrences de Marseille/Lyon sont rejetées** par le département. Les **28 occurrences de Dordogne passent le repli** grâce à leur commune reconnue et au préfixe 24, malgré le code postal inadéquat ; 25 sont encore futures/en cours. L’anomalie géographique ne se traduit donc pas toujours par une disparition d’Explorer.

Limites : ce comptage cible la confusion démontrable postal=INSEE ; ce n’est pas un audit exhaustif de toute géographie incorrecte. Pour les 1 705 lignes sans INSEE source archivé, une recherche supplémentaire par code INSEE de la commune nommée n’a trouvé aucun autre cas, sans permettre de garantir l’absence d’autres erreurs. Le référentiel local lui-même n’est pas une preuve exhaustive sur les CEDEX ou codes spéciaux.

## 4. Décision recommandée pour le pilote

**B — exclure ces quatre occurrences et les remplacer par quatre occurrences entièrement conformes dans un nouveau plan, après autorisation.** Le plan scellé actuel n’a pas été modifié et aucun remplaçant n’a été injecté.

Pour les dossiers originaux, le traitement conservatoire est **C : rester en REVIEW** tant que la géographie de leurs séances n’est pas clarifiée. L’option A n’est pas justifiée maintenant : il n’existe pas de correction postale unique prouvée pour ce festival multi-lieux. Un nouveau pilote doit revalider 75 dossiers avec dates, DISTINCT, diagnostics, identités et acceptation du zonage ; il ne faut pas masquer une correction de données dans le writer historique.

Quatre occurrences inchangées :

| ID | Début UTC | Statut |
|---|---|---|
| 431ea32c-9d0b-423e-bae8-6990c19ff2a6 | 2026-11-11 19:00:00+00 | review |
| 4560b6b9-95a0-41b5-a00e-1e48adc99540 | 2026-11-10 19:00:00+00 | review |
| 59f5681f-cf27-4384-bf1d-85dda6153a27 | 2026-11-12 23:00:00+00 | review |
| 611d18de-c5df-4f90-bad8-a5c0ccaf7f71 | 2026-11-06 20:00:00+00 | review |

## 5. Scheduler : trois situations à distinguer

Workflow distant lu sur main, identique au fichier local audité. Branche par défaut main, dépôt actif et non archivé ; workflow active, Actions autorisé. Cron ***/5 * * * *** ; serveur **04:00 Indian/Reunion**, UTC+4, fenêtre **00:00–00:40 UTC**. Aucun réglage ou secret de déploiement modifié.

| Situation | Preuve | Conclusion |
|---|---|---|
| Aucun workflow dans la fenêtre | 29 octobre : aucun run créé/démarré entre 00:00 et 00:40 UTC ; voisins à 23:24 le 28 et 02:33 le 29 | Aucun tick livré dans le créneau observable |
| Workflow réussi, tick not due | 29 octobre à 02:33, puis autres runs hors fenêtre ; HTTP 200, triggered=false, reason=not due | Le serveur fonctionne mais refuse un tick hors créneau |
| Workflow réussi, tick started, traitement en échec | 30 octobre **00:11:44 UTC = 04:11:44 Réunion**, run **40978128936**, HTTP 200 triggered=true status=started | Le cycle naturel a démarré ; sa réussite doit être lue dans les journaux métier |

Sur les **100 runs consultés**, **100 success**, aucun job GitHub échoué ou en attente. Les runs créés démarrent ici immédiatement ; on ne voit pas de job GitHub créé à 04:00 puis en attente pendant des heures. En revanche, le journal Actions ne révèle pas pourquoi aucun événement observable n’a été créé dans la fenêtre du 29 : retard en amont, omission ou cause plateforme restent non départagés. Les possibilités de retard/abandon de schedule documentées par GitHub ne démontrent pas la cause de cet incident : https://docs.github.com/en/actions/how-tos/troubleshoot-workflows .

### Échec réel du cycle naturel du 30 octobre

La base montre **8 runs enveloppes scheduler-source-v1 et 8 source runs : 8 failed, 0 completed, 0 événement collecté**.

- Trois producteurs Senlis : erreur **apiKey est obligatoire (clé publique OpenAgenda, jamais hardcodée)**. Le code appelant fournit process.env.OPENAGENDA_PUBLIC_KEY ; la valeur n’est donc pas disponible/non vide au point d’appel dans ce déploiement.
- Cinq producteurs Réunion : **HTTP 403** lors de la lecture de leur configuration d’agenda (2568169, 50316469, 4740352, 40627992, 1059482). Un problème de clé/droits est à contrôler ; la seule réponse 403 ne permet pas d’affirmer que tous ces agendas ont exactement la même cause que Senlis.
- Aucun run DATAtourisme dans ce cycle observé. Le code ne l’ajoute que si DATATOURISME_API_KEY est présente et la limite POI positive. Les logs ne tranchent pas entre clé absente et périmètre volontairement désactivé ; aucun accès au secret distant n’a été tenté.

Le verrou est libéré en **completed à 00:12:07.727 UTC** ; aucun état running persistant à la lecture finale. Cela confirme le fonctionnement du mutex et de sa libération, **pas la réussite des producteurs**.

GitHub affiche success parce que le endpoint renvoie started sans attendre workPromise ; l’Action vérifie seulement HTTP 200. L’échec du travail asynchrone est donc invisible à ce contrôle. C’est un écart de supervision démontré, indépendant du writer transactionnel.

État mesuré à **2026-10-30 02:40:43.997193+00** : **79 571 activités, 80 287 provenances, 240 283 external IDs, 0 lot historique**. Les huit échecs naturels ont créé des traces de runs, sans collecte d’événements. Aucune de ces exécutions n’a été demandée ou déclenchée par l’investigation.

**Verdict scheduler : DÉFAILLANT**, car un cycle naturel est maintenant démontré et ses huit producteurs échouent, malgré un workflow vert. La ponctualité future reste en plus non garantie par les traces disponibles.

## 6. Corrections nécessaires, non appliquées

1. Corriger la donnée géographique en amont avec le producteur, ou établir les lieux propres aux séances avant une correction locale explicitement autorisée. Ne pas convertir un INSEE en code postal par simple préfixe, géocodage le plus proche ou choix du premier code de la commune.
2. Prévoir un diagnostic postal/commune/INSEE qui distingue les 20 égalités légitimes des valeurs inadéquates ; garder les identifiants INSEE et postaux dans des champs séparés. Le writer actuel n’ajoute pas cette validation géographique.
3. Traiter la commune parent Marseille/Lyon dans le référentiel selon une règle explicite, sans rendre valides leurs codes INSEE comme codes postaux.
4. Pour l’auditabilité, envisager la conservation du fragment géographique source avant normalisation dans les futurs payloads. Ce besoin n’autorise aucune migration ou réingestion ici.
5. Configurer/vérifier OPENAGENDA_PUBLIC_KEY dans l’environnement réel du scheduler, puis vérifier les droits de lecture des cinq agendas Réunion. Aucun secret n’a été affiché ou changé.
6. Faire remonter le statut réel des cycles et des sources dans la supervision ; HTTP 200 started ne doit pas être traité comme un certificat de collecte réussie.
7. Examiner séparément la livraison des ticks et sa tolérance horaire ; ne pas conclure à une cause GitHub précise sans preuve fournisseur. Aucun cron ou horaire modifié.

## 7. Risques et limites

Les coordonnées génériques d’un festival multi-lieux n’établissent pas un lieu par séance. Un correctif géographique global aveugle pourrait créer de fausses adresses ou casser les coïncidences INSEE/postal légitimes. Le référentiel et les payloads historiques incomplets limitent l’exhaustivité du diagnostic. Le plan de 75 reste inchangé mais non autorisable ; tout remplacement ou correction nécessite un nouveau scellement et une revalidation fraîche. Le défaut du scheduler n’invalide pas les tests du mutex ou du writer, mais empêche de certifier le pipeline quotidien de production.

Preuves durables sans secrets : **sortir/recovery-data/2026-10-30-marseille-scheduler-audit/** (exclu de Git). Principaux fichiers : four-current.json, jazz-current-source.json, mapping-trace.json, geographic-extent-summary.json, suspect-source-verification.json, scheduler-summary.json et current-scheduler-database-final.json. Aucun ancien snapshot /tmp utilisé pour les comptages de cette investigation.

Aucun fichier de code modifié. Nouveau rapport et preuves locales uniquement ; les modifications préexistantes restent intactes. État Git consigné dans git-status.txt. Aucun commit/push.

**GÉOGRAPHIE PILOTE : CORRECTION NÉCESSAIRE**

**SCHEDULER : DÉFAILLANT**

**PILOTE 75 : NON AUTORISABLE**
