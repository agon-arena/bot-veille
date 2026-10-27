# Test intermédiaire DATAtourisme — arrêt de sécurité

Tentative le 21 octobre 2026, diagnostic en lecture seule après reprise le 22 octobre 2026 (fuseau utilisateur : Indian/Reunion).

**Verdict B : correction de pagination nécessaire avant de retenter le lot de 1 000 POI. Aucun scan national autorisé par ce résultat.**

## Précontrôle

Branche main, HEAD et origin/main `75299c3`, dépôt propre avant le test. Les 468 vérifications locales étaient vertes. La migration était déjà installée : vingt références POI accessibles et début de scan batch exécuté avec succès. Aucune migration réappliquée.

État initial : 2 323 activités, 2 539 provenances, 7 220 external IDs, 20 états POI, 73 runs ingestion, 104 runs source, 5 049 collection items, 3 décisions de déduplication. Statuts : 1 024 active, 1 017 review, 278 stale, 4 merged. Zéro doublon technique de provenance/external ID, zéro orphelin de ces références, zéro run ingestion/source running, 96 activités multisources. Le processus de snapshot avait un RSS de 171,4 Mio, incluant les données d'intégrité chargées en mémoire.

## Chemin prévu et limite

Harnais ponctuel local : lecteur national réel `createNationalPageFetcher`, runner `runNationalScanBatched` avec checkpoint 1 000 et maxPages 10, `receivedPoiProcessor`, comparateur d'état durable, persister normal et réconciliation. Aucune couche remplacée par un store simulé. Pas d'appel à `finalizeNationalScan` : dix pages d'un vrai catalogue ne constituent pas un scan national complet. La troncature intentionnelle après acquittement des 1 000 POI aurait été suivie d'un abandon explicite du checkpoint. Cette étape n'a pas été atteinte.

Le harnais surveillait le RSS (arrêt au-dessus de 700 Mio), la croissance par tranche de 100 POI et les relectures de candidats déjà couverts. Aucun seuil n'a été dépassé avant l'arrêt.

## Passage 1 : arrêt avant calcul/persistance

Le début du checkpoint batch a réussi. La première page HTTP 200 a livré cent objets. Le validateur `nextUrl` a ensuite refusé le lien `meta.next` avec `Paramètre de pagination non reconnu`.

Le diagnostic en lecture seule a reproduit la structure réelle du lien : même origine `https://api.datatourisme.fr`, même chemin `/v1/entertainmentAndEvent`, paramètres `fields`, `lang`, `page_size`, `filters`, **`crs`**. Le validateur accepte actuellement `page`, `cursor`, `search_after`, mais pas `crs`. C'est la cause précise de l'arrêt. La valeur opaque du curseur n'est pas reproduite ici.

- POI lus pendant la tentative : **100 sur les 1 000 prévus**.
- NEW/CHANGED/UNCHANGED/invalides et KEEP/DENY : **non calculés**, le traitement n'a pas commencé.
- Occurrences sélectionnées, ajoutées, retirées ou persistées : aucune opération exécutée.
- Candidats chargés, fenêtres lues, cache : zéro.
- Appels DATAtourisme de la tentative : **1**, environ 1,10 s.
- Requêtes Supabase de la tentative : **2 = 1 lecture d'état de précontrôle + 1 RPC mutante de démarrage**. Aucune écriture métier ni observation de POI.
- Temps réseau Supabase instrumentés : environ 661 ms et 426 ms. La durée totale d'un lot n'est pas disponible, puisqu'il n'a pas été traité.
- Pic RSS instrumenté du runner : **120,2 Mio**, sans traitement d'occurrences.
- Aucune tranche de 100 POI persistés : pas de mesure de performance exploitable à cette granularité.

## Passage 2

**Non exécuté.** Aucun rejeu ni relance automatique après l'anomalie.

## Checkpoint conservé

Source DATAtourisme : `0702abac-85d0-4d54-8321-7edc128c2a7d`.
Scan : `2ad47f77-982d-4afc-94e3-c56edba85ca3`.
now logique original : `2026-10-21T18:45:07.661Z`.

État réel après arrêt : `status=running`, `pages=0`, `received=0`, `total=null`, `pending=null`, `batch_size=1000`. Les cent objets ont été reçus dans Node, mais aucune observation de lot n'a été envoyée à Supabase.

Ce checkpoint empêche de démarrer un autre scan tant qu'il n'est pas repris ou explicitement abandonné. Il ne peut pas être finalisé et aucune absence n'a progressé. Il a été laissé intact pendant la pause et le diagnostic en lecture seule ; ne pas le confondre avec un run d'ingestion bloqué (aucun run d'ingestion/source n'a été créé).

Avant une nouvelle tentative, abandonner explicitement ce scan avec la RPC `sortir_dt_fail_national_scan`, puis démarrer un nouveau scan. Ne pas marquer artificiellement ce checkpoint complete/finalized et ne pas modifier son périmètre pour le faire passer.

## Intégrité après arrêt

Snapshot complet comparé au précontrôle, sans ignorer les champs d'audit :

| Table | Avant | Après | Lignes strictement identiques |
| --- | ---: | ---: | --- |
| Activités | 2 323 | 2 323 | oui |
| Provenances | 2 539 | 2 539 | oui |
| External IDs | 7 220 | 7 220 | oui |
| États POI | 20 | 20 | oui |
| Runs ingestion | 73 | 73 | oui |
| Runs source | 104 | 104 | oui |
| Collection items | 5 049 | 5 049 | oui |
| Décisions de déduplication | 3 | 3 | oui |

Les huit sources sont également inchangées, hormis le champ du checkpoint de la source nationale. Statuts, provenances multisources et identifiants sont donc préservés. Aucun doublon technique, orphelin ou run ingestion/source running. Aucune activité touchée à échantillonner.

## Diagnostic et coût hors tentative

Le diagnostic a relu **une seule page** DATAtourisme, sans suivre son lien suivant et sans aucune écriture. Le total annoncé par cette réponse est 64 571 ; cela constitue une métadonnée de première page, pas un catalogue parcouru. Deux requêtes API au total : tentative et diagnostic.

Les snapshots initial et après arrêt représentent chacun 42 lectures REST Supabase. Tentative + deux snapshots = **86 requêtes REST instrumentées : 85 lectures et une unique écriture de checkpoint**. Aucun trafic caché d'ingestion ou migration.

## Extrapolation nationale

Impossible de déduire durée de persistance, mémoire nationale, volume candidat ou écritures métier de ce test interrompu avant traitement. Les résultats du benchmark simulé et du test de vingt POI ne remplacent pas les mesures demandées sur mille.

Pour 61 289 POI et des pages de 100 : modèle de contrôle inchangé, environ 613 requêtes API et 126 RPC de contrôle pour un vrai scan complet à checkpoints de dix pages. À titre arithmétique, 64 571 POI annoncés nécessiteraient environ 646 pages et 132 RPC de contrôle. Ces nombres ne couvrent ni comparaison des empreintes ni persistance/réconciliation ; aucun scan de cette taille n'a été lancé.

## Correction à préparer et validation manquante

Autoriser explicitement `crs` dans le validateur de pagination, avec un test reproduisant la forme réelle observée. Préserver tous les contrôles d'origine, de chemin, de champs, langue, page_size et filtre ; ne pas autoriser arbitrairement tous les paramètres. Ajouter des régressions empêchant un changement de périmètre via le nouveau curseur. Aucun correctif applicatif n'a été introduit pendant le diagnostic.

Les 468 vérifications existantes ont été relancées après l'arrêt : **468/468 vertes, 28 scripts**. Leur succès ne couvre donc pas encore ce format réel de pagination.

## Git et arrêt

Aucun fichier de code ou migration modifié. Seul ce rapport est ajouté, non committé. HEAD reste `75299c3` sur main. Aucun scheduler modifié, plafond 300 de production conservé, aucun OpenAgenda, aucun commit/push. Le lot de 1 000 POI n'est pas validé ; arrêt maintenu en attente de correction et d'une nouvelle tentative explicitement encadrée.

Artefacts locaux : `/private/tmp/dt-intermediate-validation/` (précontrôle, erreur, progression, diagnostic de pagination et comparaison d'intégrité). Aucune clé API enregistrée dans ce rapport.
