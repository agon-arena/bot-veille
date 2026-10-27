# Silver Friday — audit en lecture seule et proposition de quarantaine

25 octobre 2026. **Verdict B : catégorie D, REVIEW conservée. Aucune modification du dédoublonneur ou du comportement d’ingestion.**

L’hypothèse la plus plausible est celle de deux versions éditoriales d’un même programme. Ce n’est pas une preuve suffisante d’identité automatique de chaque offre/occurrence : les fiches décrivent un ensemble de visites, ateliers, concerts et animations, sans identifiant canonique d’événement partagé ni relation explicite d’équivalence/remplacement. Une décision humaine ou une confirmation du producteur pourrait lever cette incertitude. Il n’existe pas de preuve positive d’activités différentes permettant DISTINCT. Les dix collisions ne sont pas non plus dix horaires différents entre les fiches : leurs intervalles sont strictement identiques deux à deux.

Le seuil textuel 0,85 explique la décision actuelle mais ne constitue pas, à lui seul, la justification métier de REVIEW. Descendre ce seuil pour passer 0,827956989 serait une nouvelle heuristique générale risquée ; ce n’est pas proposé.

## Représentations comparées

A = fiche déjà persistée page 58 ; B = fiche entrante page 107, index zéro 95, position nationale 10 696. Dix occurrences de A sont en base, dix correspondances B restent bloquées. Aucun troisième UUID n’apparaît dans les activités candidates de ces dix collisions.

| Champ | A — existante | B — entrante | Comparaison |
|---|---|---|---|
| UUID DATAtourisme | `170846a2-2e11-393a-b970-42c8902b90ae` | `2b09651e-3cbc-3cee-bc7b-28bef676f38f` | différents |
| Producer ID | `FMAPIC000V568280886` | `FMAPIC000V573355848` | différents |
| Titre | Silver Friday | Silver Friday | identique |
| URI originale | https://data.datatourisme.fr/28/620b1450-54df-3e35-ae57-76037350888d | https://data.datatourisme.fr/28/58a63c83-d945-311e-aa12-2dc8f44a0470 | différentes |
| Description | programme détaillé, dont 27 novembre / 4 décembre ; thèmes des 23 et 30 octobre précisés | programme comportant septembre ; thèmes des 23 et 30 octobre encore à venir | différentes, similarité 0,827956989 |
| Périodes brutes | 18 | les mêmes 18, ordre différent | même ensemble exact |
| Sélection au now original | 10 | les mêmes 10 | même ensemble exact |
| Heure locale de chaque période | 14:00–17:00 | 14:00–17:00 | explicites, identiques |
| Fuseau | Europe/Paris | Europe/Paris | identique |
| Rue | 1 allée du Musée VIlleneuve-d’Ascq | même chaîne | identique |
| Commune / code postal / INSEE | Villeneuve-d’Ascq / 59650 / 59009 | idem | identiques |
| Pays / département / région | France / Nord 59 / Hauts-de-France 32 | idem | identiques |
| Venue name | absent | absent | absence commune, pas preuve d’identité |
| Coordonnées | 50.637583, 3.148595 | 50.637583, 3.148595 | identiques |
| Organisateur normalisé | aucun | aucun | pas de corroboration par organisateur nommé |
| Contact brut | +33 3 20 19 68 68 | idem | commun, pas identifiant d’événement |
| Homepage / booking URL du POI | aucune dans l’archive | aucune dans l’archive | pas de lien source canonique partagé |
| Catégories | Event, EntertainmentAndEvent, CulturalEvent, Festival, ShowEvent, SocialEvent, Parade, Carnival, PointOfInterest | même ensemble | ordre différent seulement |
| Taxonomie Mnoria category/subcategory | non renseignée | non renseignée | identique |
| État durable | empreinte validée, needs_reprocess=false | empreinte/version nulles, needs_reprocess=false | B non validé |
| Provenances / external IDs en base | 10 actives / 30 IDs | 0 / 0 | vérifié en lecture |
| Activités | 10 actives | aucune | aucune insertion B |

Empreinte A : `c26b76c3a30ef9023389c309063290705b7a3e3cf3173c137ca2315b087f06c2`, algorithme `datatourisme-mnoria-v1`. L’état B existe comme observation, sans référence validée. Le champ needs_reprocess=false ne transforme pas une empreinte nulle en UNCHANGED.

Les données intégrales, descriptions complètes, périodes brutes, normalisations, payloads, clés, activités, provenances et external IDs sont dans [datatourisme-silver-friday-audit.json](datatourisme-silver-friday-audit.json). Chaque représentation possède la description complète une seule fois au niveau raw ; les occurrences y renvoient, sans inventer une description propre à chaque date.

## Relations publiques vérifiées en lecture

Les deux pages DATAtourisme publiques renvoient aux mêmes nœuds de période (18), lieu (`987d7e58-347c-3cd5-b8e1-3929b5c0cf08`), contact (`e156f7d1-6090-37c1-b8f4-5c217a409b69`), conditions de vente (`5c32b1ee-3e94-3083-99d8-78f4942e6fec`) et création/publication/propriété (`28/29201d37-5890-333c-917e-c22820a3a0b9`). Leurs nœuds de description diffèrent. Les dates source de création/mise à jour sont respectivement 16 septembre et 11 septembre 2026 ; les dates de dernière mise à jour DATAtourisme sont le 21 octobre 2026 à 03:52:37.437Z et .434Z.

Aucune propriété explicite sameAs, isPartOf/hasPart entre les deux POI, remplacement ou version n’est exposée sur les pages examinées. Des nœuds de valeurs communs ne sont pas une relation d’équivalence entre événements. Le nœud de création/publication/propriété porte le nom Hauts-de-France Tourisme ; il identifie l’agence productrice, pas un organisateur discriminant de séance. Le nœud de contact ne fournit que le téléphone déjà archivé. La même agence productrice n’est pas nécessairement l’organisateur de chaque atelier. La différence de dates source suggère une version éditoriale, sans démontrer que l’une remplace l’autre.

La [page officielle du musée](https://musee-lam.fr/fr/silver-friday) confirme le programme récurrent et son contenu ; la [billetterie officielle](https://billetterie.musee-lam.fr/fr-FR/billets) confirme l’offre Silver Friday. Ces sources corroborent fortement le programme commun, mais ne font pas le lien entre les deux identifiants DATAtourisme ni entre chaque description d’offre. Aucun horaire n’est extrait des descriptions pour remplacer les périodes structurées.

## Matrice des dix occurrences

Pour les deux fiches, chaque période brute est `{startDate: DATE, endDate: DATE, startTime: "14:00", endTime: "17:00"}`. Fuseau Europe/Paris ; aux dix dates sélectionnées, UTC+01. Même début ET même fin dans A et B. Aucun écart de parsing ou de DST ici.

| Date locale A = B | Heures locales A = B | UTC A = B | Activité A existante | Décision actuelle |
|---|---|---|---|---|
| 2026-10-30 | 14:00–17:00 | 13:00–16:00 | `0f3643d5-cdd8-427e-b2bf-7881511cc4a3` | REVIEW |
| 2026-11-06 | 14:00–17:00 | 13:00–16:00 | `5f949706-7c7b-4b84-a631-2d2ef99a1931` | REVIEW |
| 2026-11-13 | 14:00–17:00 | 13:00–16:00 | `1b00efe7-4286-435a-826e-34c253b8dd04` | REVIEW |
| 2026-11-20 | 14:00–17:00 | 13:00–16:00 | `de1a1fa3-2922-4045-afa0-4f9bfaf3bc73` | REVIEW |
| 2026-11-27 | 14:00–17:00 | 13:00–16:00 | `b9e3353f-fbdd-4b99-af40-41030bbeb8fe` | REVIEW |
| 2026-12-04 | 14:00–17:00 | 13:00–16:00 | `2f6ccdab-78c7-41f6-82b5-e39f6ba6b12c` | REVIEW |
| 2026-12-11 | 14:00–17:00 | 13:00–16:00 | `0b993602-9a3f-449a-a417-70016ef3c186` | REVIEW |
| 2027-01-08 | 14:00–17:00 | 13:00–16:00 | `4a52fdcb-5296-4742-89f7-d2942058febf` | REVIEW |
| 2027-01-15 | 14:00–17:00 | 13:00–16:00 | `690a7a17-703a-4bc6-b94f-5f14dd6bfa82` | REVIEW |
| 2027-01-22 | 14:00–17:00 | 13:00–16:00 | `a8bbca7d-cdca-4cf7-b8c2-05dd33e112c7` | REVIEW |

Les 18 périodes sont identiques comme ensembles : 11, 18, 25 septembre ; 2, 9, 16, 23, 30 octobre ; 6, 13, 20, 27 novembre ; 4, 11 décembre 2026 ; 8, 15, 22 janvier 2027 ; 18 décembre 2027. Les sept premières sont passées au now `2026-10-25T09:56:37.240Z`, la dernière est hors fenêtre. Elles ne sont pas recréées.

Pour chaque ligne, les trois external IDs attendus sont :

- `datatourisme-poi = UUID_A` ou `UUID_B` ;
- `datatourisme-producer-id = producer_A` ou `producer_B` ;
- `datatourisme-occurrence = datatourisme:UUID:<début ISO UTC>:end=<fin ISO UTC>`.

Exemple du 30 octobre : A `datatourisme:170846a2-2e11-393a-b970-42c8902b90ae:2026-10-30T13:00:00.000Z:end=2026-10-30T16:00:00.000Z` ; B `datatourisme:2b09651e-3cbc-3cee-bc7b-28bef676f38f:2026-10-30T13:00:00.000Z:end=2026-10-30T16:00:00.000Z`. Aucun external ID n’est partagé entre les POI. Les valeurs complètes des dix lignes figurent dans occurrenceMatrix du JSON joint.

## Pourquoi REVIEW bloque tout le lot aujourd’hui

1. `activity-deduplication.js::compareActivities` trouve temporalité, titre et adresse exacts, mais pas de description ≥0,85 ni d’organisateur corroborant. Il retourne REVIEW, sans contradiction temporelle ou géographique forte.
2. `supabase-persistence.js::persistSortirIngestionUnlocked` sait déjà créer une activité séparée `review`, lui rattacher provenance et external IDs et enregistrer une décision REVIEW/pending. Une activité review est un stockage d’une représentation source en attente, pas une déclaration DISTINCT ni une fusion implicite.
3. Le hook `datatourisme-activity-safety.js::guardExactSignatureReview`, ajouté pour protéger le scan, lance une exception AVANT INSERT dès qu’une signature titre/début/fin/ville existe sans preuve DISTINCT. C’est lui qui bloque ici.
4. `auditActivitySafety` refuserait ensuite le groupe de signatures identiques même si la seconde activité est stockée en review, avec une décision pending complète. Il ne charge pas les décisions et ne distingue pas encore quarantaine documentée et doublon accidentel.
5. L’échec d’une occurrence fait échouer son chunk de persistance ; aucun des 100 POI du chunk n’obtient de nouvel état validé. Le contrôle national refuse à juste titre d’acquitter un lot incomplet. Il ne faut pas affaiblir cette dernière protection.

Le schéma accepte déjà `record_status=review` (migration du 16 octobre). Les candidats internes incluent active ET review, tandis que countFinalActivities compte seulement active. La migration review ne constitue cependant ni un filtre public ni une garantie RLS. Aucun lecteur public des activités Sortir n’est établi dans le serveur inspecté : l’invisibilité sur tous les consommateurs doit être vérifiée avant tout changement.

## Proposition précise — non implémentée

**Invariant : chaque occurrence valide doit être durablement couverte par sa propre provenance et son intervalle exact ; une représentation dont l’identité est ambiguë reste non publiable, sans être fusionnée, et possède une décision de revue durable. L’acquittement signifie “source intégralement traitée”, pas “identité éditorialement approuvée”.**

Réutiliser le modèle actuel : une activité par représentation source/intervalle tant que la fusion n’est pas prouvée, une provenance active pour cette occurrence source, les trois IDs, une décision REVIEW/pending vers chacun des candidats réellement ambigus, et un collection item traçable. La provenance active signifie “source actuellement présente”, pas “activité publiée”. Pour Silver Friday, cela représenterait dix nouvelles activités review, dix provenances, trente IDs et dix liens de revue, sans modifier les dix activités/provenances A existantes. C’est une estimation de modèle, pas un dry-run réussi ni une autorisation de mutation.

### Écriture atomique, rejouable et non publiable

Une primitive transactionnelle dédiée doit conserver ensemble la représentation review, sa provenance idempotente par clé source, ses external IDs, ses liens de revue pending et sa trace de couverture. En cas de perte de réponse ou de crash : tout est enregistré ou rien ; le rejeu retrouve la même provenance et activité, sans seconde décision pending équivalente. La clé métier reste celle de l’occurrence source, jamais la signature générique ni l’ID du run.

Cette primitive ne doit ni fusionner ni réécrire l’intervalle du candidat. Elle revalide les candidats/périodes dans la transaction. Les vrais conflits de couverture, orphelins et erreurs SQL restent bloquants. Une décision pending doit identifier les clés/intervalles, la version de comparaison et les éléments de preuve ; le seul statut review peut aussi être éditorial et ne suffit pas à expliquer un doublon de signature.

Une contrainte/index d’unicité des revues pending équivalentes et une RPC atomique seront probablement nécessaires pour la garantie de crash/rejeu ; le schéma des tables de base et les index existants devront être inspectés précisément avant de proposer une migration. Aucun SQL n’a été écrit ou appliqué pendant cet audit.

### Garantie de publication

Tous les lecteurs publics doivent utiliser un accès filtré qui impose `record_status=active` et exclut toute représentation désignée comme nouvelle activité ambiguë par une revue pending. Un service privilégié doit également appliquer ce filtre ; une convention UI ne suffit pas. Empêcher la promotion en active tant qu’une telle revue reste pending, y compris lors d’une réactivation stale ou d’un MATCH ultérieur.

La nouvelle représentation B est invisible ; A, déjà connue active, n’est ni fusionnée ni dépubliée automatiquement. L’exigence “aucun doublon visible” signifie au plus une activité publiée dans le groupe ambigu. Si plusieurs activités du groupe sont déjà publiables, ce n’est pas une quarantaine saine : le précontrôle doit encore bloquer, sans choisir automatiquement une gagnante. Si la politique produit exige de masquer aussi A pendant la revue, ce serait un effet supplémentaire de dépublication, à décider explicitement ; ce n’est pas inclus dans la proposition minimale.

### Précontrôle et couverture

Le précontrôle doit distinguer `blockingIssues` et une file `pendingIdentityReviews`, chargée en batch. Une signature multiple n’est autorisée comme quarantaine que si chaque représentation ambiguë est review, soutenue par ses propres provenances, cohérente en intervalle, et reliée par des décisions pending complètes et idempotentes ; au plus une activité du groupe est publiable. Pour chaque paire de signatures identiques, exiger soit la preuve DISTINCT déjà validée, soit une décision pending reliant directement les deux activités avec au moins la nouvelle représentation non publiable : une simple chaîne transitive de revues ne suffit pas. Toute autre duplication reste bloquante. Les preuves DISTINCT établies restent traitées séparément.

La couverture existante accepte déjà active/review. L’étendre à la preuve de quarantaine durable sans remplacer une activité par le mauvais candidat. Après persistance complète, couverture vérifiée ET réconciliation réussie, l’empreinte peut être validée : elle signifie “état source capturé et traité”, même si l’identité reste en revue. Une revue pending ne doit pas disparaître lors d’un rejeu UNCHANGED : sa file de résolution est indépendante de l’empreinte. Une conversion invalide ou une transaction incomplète ne valide toujours aucune empreinte.

La finalisation nationale peut alors acquitter le lot avec un compteur explicite d’occurrences en revue. Elle ne doit jamais classer ces POI comme invalides/absents, ni conclure une disparition à partir d’un échec. Aucune tolérance aux incohérences d’intégrité n’est ajoutée.

### Résolution ultérieure

- MATCH confirmé : transaction de fusion validant encore l’égalité des intervalles, déplacement des provenances/IDs et références vivantes nécessaires, activité absorbée merged, décision résolue avec auteur/preuves/date, invalidation du cache. Une activité par séance, plusieurs provenances. Les références des collection items doivent rester auditables/cohérentes après déplacement de leur provenance.
- DISTINCT confirmé : décision résolue, deux représentations conservées ; publication soumise séparément à la qualité éditoriale, jamais automatique si d’autres revues restent ouvertes.
- Ambiguïté persistante : aucune promotion ; stockage conservé et autres POI ingérés normalement.

`mergeStoredActivities` existe mais ne fournit pas à lui seul cette résolution transactionnelle complète (il ne clôt pas les décisions, ne gère pas la politique de publication et enchaîne plusieurs appels). Ne pas l’utiliser comme réparation implicite.

### Conséquences sur le modèle

Aucune nouvelle table d’occurrences ni nouvelle définition de l’activité n’est requise : l’activité porte déjà un intervalle ; les provenances/IDs identifient les représentations source et les décisions relient les ambiguïtés. Le statut review existe. La nouveauté structurelle est la distinction entre quarantaine correctement enregistrée et erreur d’intégrité, avec persistance/résolution atomiques et publication verrouillée. Les autres sources et leurs provenances ne sont ni désactivées ni réécrites.

Le coût est un stockage de représentations review supplémentaires et une file humaine à traiter ; il faut mesurer ce volume. Il ne faut ni conserver les ambiguïtés uniquement en mémoire, ni omettre les POI du lot, ni acquitter sans couverture, ni avancer une empreinte après un échec.

## Tests à ajouter avant implémentation réelle

1. Archive Silver Friday : dix REVIEW durables, dix activités existantes inchangées, dix nouvelles review, vingt provenances couvertes ; zéro nouvel élément public.
2. Rejeu identique : mêmes IDs et décisions, zéro nouvelle ligne métier, empreintes stables, file de revue toujours accessible.
3. Crash après chaque étape et réponse perdue après COMMIT : atomicité, absence d’orphelin et rejeu sans duplication ; aucune empreinte sur transaction échouée.
4. Concurrence sur la même clé source : une seule activité/provenance, un seul lien pending équivalent.
5. Groupe quarantainé sain non bloquant ; groupe sans décision, sans soutien, intervalle faux, deux activités publiables ou revue inconnue toujours bloquant.
6. Lecture publique réelle avec rôles pertinents, accès direct et accès service : aucune review visible ; promotion/réactivation interdite pendant pending.
7. Résolution MATCH/DISTINCT idempotente ; conservation multisource, références collection items, statut qualité indépendant, caches invalidés.
8. Source modifiée, occurrence retirée/réapparue, POI absent deux fois : review conservée/réconciliée correctement, pas de promotion accidentelle ou de disparition artificielle.
9. Quarantaine au milieu d’un lot : les POI suivants continuent ; ACK uniquement après toutes les couvertures ; échec SQL réel reste fatal.
10. Régression complète : Noël, Anne, Singulières, Lanvénégen, séances distinctes, conflits de lieu/heure et exception historique inchangés.

## État opérationnel

Aucune reprise et aucune écriture Supabase. Trois lectures DB ont confirmé le JSON intégral du checkpoint identique, les dix provenances A inchangées et zéro provenance B. Le lot reste failed : 110 pages reçues / 100 acquittées, pending 101–110, 1 000 POI. Le now du pending reste 2026-10-25T09:56:37.240Z. Aucune empreinte Silver Friday B validée ; aucune finalisation.

Le dry-run précédent reste 1 290/1 300 couvertures ; il n’a pas été rendu permissif ni relancé avec un contournement. Les 240 couvertures antérieures restent conservées. La proposition REVIEW n’est pas implémentée.

Le code exécutable reste inchangé pendant cet audit. Seuls le présent rapport et son JSON de preuves sont ajoutés. Aucun scheduler/OpenAgenda, migration, commit/push. Tests complets relancés : **568 vérifications / 34 scripts, zéro échec**. `git diff --check` propre. HEAD `0d17e89`, branche main ; tous les changements antérieurs sont conservés.
