# DATAtourisme — ateliers distincts sous un programme commun

Validation manuelle du 25 octobre 2026. En cours ; aucune conclusion de réussite nationale à ce stade.

## Audit Lanvénégen

| | Fiche existante | Fiche entrante |
|---|---|---|
| UUID | 092d8ee7-e610-3a05-a105-6e305e901260 | 28f6fbfd-a9fc-3e99-a0ef-da4a1fcbc5c3 |
| Producteur | FMABRE056V50HA3B | FMABRE056V50H8XI |
| Sujet explicitement annoncé | visite de l’atelier le meuble du photographe | visite de l’atelier l’En verre du Décor et l’instant de verre |
| URI source | https://data.datatourisme.fr/38/88056ab3-f6f8-3307-b94d-51e9e4841c10 | https://data.datatourisme.fr/38/91eba088-94a0-352c-aaaf-ee5232293378 |

Les deux descriptions ont le même texte de programme, mais désignent explicitement deux ateliers différents dans une phrase autonome. C’est une preuve positive de distinction, et pas une déduction tirée de champs manquants. Le titre générique commun est « Les Semaines du Tourisme Économique et des Savoir-Faire ».

Les deux fiches ont la même période sans horaires, du 19 octobre au 1er novembre 2026 : 18 octobre 22:00 UTC au 1er novembre 22:59 UTC, Europe/Paris. Elles n’ont ni rue, ni nom de lieu, ni organisateur nommé. Commune Lanvénégen, INSEE 56105, code postal 56320, France. Contacts communs +33297232323 / +33297280120 et URL de programme https://semaines-tourisme-economique.bzh/retrouvez-vos-visites-dans-le-morbihan/pays-du-roi-morvan/ ; cette URL n’identifie pas un atelier unique. Même ensemble de catégories Event/EntertainmentAndEvent/Product/Visit/PointOfInterest. Aucune relation parent/programme explicite n’est exposée dans le sous-ensemble archivé ; cela ne prétend pas couvrir tout le graphe RDF.

Coordonnées communes 45.4587971, -94.418775 : incompatibles avec la commune française annoncée. Anomalie source conservée, non corrigée, non utilisée comme preuve d’identité. L’origine précise de ce géocodage n’est pas démontrée.

La mairie confirme indépendamment l’existence du Meuble du Photographe : https://www.lanvenegen.bzh/page/vie-economique ; la fiche institutionnelle https://www.tourismebretagne.com/preparer-mon-sejour/agenda/les-semaines-du-tourisme-economique-et-des-savoir-faire-lanvenegen-fr-6837032/ nomme ce même atelier. La preuve de distinction avec l’autre atelier est la désignation explicite différente dans les deux descriptions DATAtourisme archivées.

L’activité existante est 7522e7dd-9f8b-4cc3-8186-5937a747ef63, provenance 7b7abd24-c2d2-4030-bf71-cf4640279503. Les external IDs POI/producteur/occurrence sont propres à chaque fiche. Aucune provenance n’avait été insérée pour la seconde au point d’arrêt. Son empreinte n’avait pas été validée.

## Règle générale

Version du dédoublonneur : sortir-dedup-v4. Pour deux UUID et identifiants producteurs distincts, sans identifiant partagé ni URL d’événement originale commune, le dédoublonneur peut conclure DISTINCT lorsque : titre et commune identiques ; chaque description contient exactement une phrase autonome « À <commune>, visite de l’atelier <nom> » ; le texte de programme restant est identique et substantiel ; chaque nom contient au moins deux mots significatifs et leurs mots significatifs sont disjoints.

Aucun nom de commune, de programme ou d’atelier n’est codé en exception. Les autres divergences de description ne suffisent pas. Les protections temporelles s’exécutent avant cette règle. Les cas réellement ambigus restent REVIEW ; les identités fortes restent MATCH. La qualité éditoriale peut laisser une nouvelle activité en statut review même si son identité est DISTINCT.

Le garde-fou avant INSERT reconnaît seulement ce signal positif DISTINCT. Le précontrôle global recharge descriptions et external IDs en batch et recalcule la même preuve pour chaque paire d’un groupe de signatures identiques. Aucun groupe ambigu, sans soutien actif ou interrompu n’est exempté.

## Preuves opérationnelles

Dossier isolé : /private/tmp/dt-distinct-visits-validation/.

Précontrôle, dry-run, reprise et résultat national à compléter après leur exécution. Aucun scheduler, OpenAgenda, commit/push ou changement du plafond de production.

## Résultat — verdict B, arrêt avant reprise réelle

Lanvénégen est arbitré DISTINCT sur preuve positive. Le test du pipeline en mémoire crée deux activités/provenances, puis obtient deux UNCHANGED sans repersistance. Les tests Noël, Anne de Bretagne, Singulières et multi-sessions passent.

Précontrôle réel : 13 029 provenances DATAtourisme actives et 13 208 activités active/review examinées, 55 lectures. Seule subsiste l’exception historique réservée « Lever du soleil sur le Causse Méjean », strictement inchangée. Aucun run running, doublon de clé ni orphelin. 96 activités multisources préservées. Le snapshot complet est identique à celui de l’arrêt précédent.

Dry-run des pages 101–110 au `now` original **2026-10-25T09:56:37.240Z** :

- 1 000 POI, 991 calculables NEW, 9 invalides `ends_before_start` ; 1 300 occurrences sélectionnées.
- Lanvénégen passe ; ses deux activités restent distinctes.
- 1 290 occurrences couvertes, aucune couverture au mauvais intervalle ; les 240 provenances antérieures du pending conservent ID, rattachement, clé et statut actif.
- **Nouveau blocage sur Silver Friday**, page **107**, index zéro 95, position nationale **10 696** : UUID entrant `2b09651e-3cbc-3cee-bc7b-28bef676f38f`, producteur `FMAPIC000V573355848`, confronté au UUID `170846a2-2e11-393a-b970-42c8902b90ae`, producteur `FMAPIC000V568280886`.
- Dix occurrences communes du 30 octobre 2026 au 22 janvier 2027, 14:00–17:00 locales, mêmes intervalles UTC, même fuseau Europe/Paris, titre exact, adresse exacte `1 allée du Musée VIlleneuve-d'Ascq`, 59650 Villeneuve-d’Ascq, mêmes coordonnées 50.637583/3.148595. Aucun organisateur nommé. Les descriptions ne sont pas identiques : les programmes détaillés et annonces de séances diffèrent. Similarité 0,827956989, sous le seuil 0,85 existant ; aucune preuve organisateur de remplacement. Le dédoublonneur reste REVIEW ; aucune règle n’a été assouplie pour ce nouveau cas.
- Le premier candidat est l’activité `0f3643d5-cdd8-427e-b2bf-7881511cc4a3` ; les neuf autres et les données intégrales sont conservés dans `/private/tmp/dt-distinct-visits-validation/new-block-evidence.json`.
- Le dry-run complet en mémoire donne 1 022 activités / 1 050 provenances / 3 150 IDs supplémentaires simulés, 28 MATCH et une décision REVIEW écrite en mémoire. Ce ne sont PAS des écritures réelles. 891 états sont validables dans cette simulation ; les 100 états du chunk contenant le POI bloquant restent non validés. Cela ne signifie pas 100 POI problématiques : les dix couvertures manquantes appartiennent à un seul POI.
- L’empreinte du POI bloquant n’est pas validée, même dans la simulation. La vérification exhaustive de couverture et le rejeu global ne passent donc pas : le lot est volontairement non acquittable. Aucun rejeu réel n’a été tenté.

Une lecture de contrôle de la page suivante conservée confirme un curseur valide (100 POI, total catalogue 62 940 inchangé). Il s’agit d’un seul appel API en lecture, pas d’une continuation de l’ingestion.

## Base et checkpoint inchangés

| Table | Avant | Après |
|---|---:|---:|
| Activités | 14 947 | 14 947 |
| Provenances | 15 210 | 15 210 |
| External IDs | 45 581 | 45 581 |
| États POI | 11 026 | 11 026 |
| Runs ingestion | 233 | 233 |
| Runs source | 264 | 264 |
| Collection items | 21 161 | 21 161 |
| Décisions dédoublonnage | 105 | 105 |

Statuts inchangés : active 6 545, review 6 663, stale 1 735, merged 4. Compteurs finaux revérifiés par 9 HEAD et le JSON intégral de la source par GET : identiques. **Zéro écriture Supabase**, zéro appel pipeline réel. Aucun RSS d’ingestion à rapporter, car aucun processus d’ingestion réelle n’a été lancé.

Checkpoint `384c3c2f-649f-482f-a3dd-9431e6e163fc` : toujours `failed`, **100 pages / 10 000 POI acquittés**, **110 pages / 11 000 POI reçus**, pending de 1 000 POI, pages 101–110 conservées intégralement. Aucune finalisation nationale.

## Code et vérification

Fichiers concernés par cette étape : `activity-deduplication.js`, `datatourisme-activity-safety.js`, `datatourisme-preflight.js`, `test-datatourisme-inter-poi.js` et ce rapport ; fixture archivée Lanvénégen conservée. Les changements déjà présents restent intacts. HEAD `0d17e89`, branche main ; dépôt déjà modifié, aucun commit/push. Des modifications médias/YouTube étrangères à cette tâche sont présentes et n’ont pas été touchées.

Suite : 568 vérifications / 34 scripts, zéro échec ; `git diff --check` propre. Le nouveau cas Silver Friday requiert un audit/décision distinct ; aucune reprise avant sa résolution démontrée.
