# Audit DATAtourisme après arrêt page 13 — 23 octobre 2026

**Verdict B : pas de reprise.** Le résidu est neutralisé, les correctifs locaux sont verts,
mais le dry-run refuse l'acquittement du pending à cause du conflit inter-UUID Singulières.
Il faut arbitrer ce cas et autoriser/valider la nouvelle RPC d'horloge avant toute reprise.
Aucune nouvelle page, ingestion réelle, réparation générale, reprise ou finalisation.
Une seule écriture réelle : nettoyage ciblé autorisé, une activité review → stale.

## Les deux UUID Singulières

Conclusion de l'audit **A : deux représentations source de la même exposition**. Cela découle
conjointement des 116 périodes brutes identiques après tri, du lieu exact, du téléphone,
des commissaires nommés, des œuvres, du fonds L'Aracine et de l'essentiel du texte. La seule
signature titre/lieu/intervalle ne suffit pas, et le dédoublonneur reste REVIEW.

| Champ | Fiche déjà présente | Fiche du pending |
|---|---|---|
| UUID | 024207fe-3c2c-3dde-978b-9c620aa19ef9 | 04e718a7-4711-3b1e-abe3-119144ba4ccb |
| Identifiant producteur | FMAPIC000V556036912 | FMAPIC000V595766817 |
| URI | https://data.datatourisme.fr/28/4124480e-11da-3924-8f24-091c450d1e95 | https://data.datatourisme.fr/28/103c7024-daf6-39e4-bbd9-da2426fc7509 |
| Titre | Singulières : artistes, autodidactes, affranchies | identique |
| Adresse | 1 allée du Musée VIlleneuve-d'Ascq, 59650 Villeneuve-d'Ascq, INSEE 59009 | identique |
| Coordonnées | 50.637583 / 3.148595 | identiques |
| Téléphone | +33 3 20 19 68 68 | identique |
| Organisateurs structurés / image / réservation | absents | absents |
| Types | Event, EntertainmentAndEvent, SaleEvent, PointOfInterest, FairOrShow | même ensemble, ordre différent |
| Périodes | 116 dates et horaires | même ensemble de 116, ordre différent |
| Premier intervalle conflictuel | 22/10/2026 11:00–20:00 local | identique |
| UTC / fuseau | 09:00–18:00Z, Europe/Paris | identique |
| Provenances avant nettoyage | 44 historiques, 30 actives | aucune |
| Empreinte durable | ee2673cf539dc59c8811fb7e7a0bba87c7d140241192488cfa2ce8543b5641fa | NULL |
| needs_reprocess | false | false |

Le nouveau texte ajoute une liste d'artistes (Baya, Aloïse Corbaz, Madge Gill, Jeanne
Laporte-Fromage, Séraphine Louis, Élise Müller, Anna Zemánková), les partenaires média et du
formatage Markdown. Le noyau descriptif et les deux commissaires Savine Faupin / Christophe
Boulanger sont communs. Les openingHoursSpecification sont aussi identiques en ensemble ;
les différences d'ordre ne constituent pas deux programmes. Aucune URL officielle commune
n'est fournie par ces champs : les deux liens normalisés sont leurs URI DATAtourisme distinctes.

Les external IDs prévus sont trois espaces : datatourisme-poi, datatourisme-producer-id et
datatourisme-occurrence. Ils diffèrent entre UUID ; aucune identité forte partagée n'est donc
inventée. Les clés du cas initial sont :

* datatourisme:024207fe-3c2c-3dde-978b-9c620aa19ef9:2026-10-22T09:00:00.000Z:end=2026-10-22T18:00:00.000Z
* datatourisme:04e718a7-4711-3b1e-abe3-119144ba4ccb:2026-10-22T09:00:00.000Z:end=2026-10-22T18:00:00.000Z

Le candidat existant est 0c63ca4a-00fc-4674-9a3d-565720853ab0. Signaux : similarité titre 1,
delta début 0, distance 0, adresse et ville identiques, probable_composite_match.
Décision REVIEW, sans preuve d'identité commune dans les IDs/organisateurs.
La solution métier envisageable est une association explicite et auditée de CE couple de fiches,
occurrence par occurrence à intervalle identique, avec conservation des deux provenances.
Elle n'est ni codée ni exécutée ici ; aucune règle globale « signature égale → MATCH » ajoutée.

Les sources intégrales, champs normalisés et comparaisons sont conservés dans
/private/tmp/dt-page13-audit/singulieres.json (sans secret).

## Cause de l'activité sans provenance et correctif

Ordre prouvé dans le pilote interrompu /private/tmp/dt-six-repair-and-resume/national/run.cjs :

1. Le pipeline décide REVIEW puis attend store.createActivity.
2. Le serveur INSERT l'activité 4588b8a1-d113-4c30-b1b5-89b313001b36 à 05:43:38.182648Z.
3. Le transport reçoit la réponse et y recherche une signature déjà en stock.
4. Il lève une erreur AVANT de retourner l'activité au pipeline.
5. L'assignation unlinkedActivityId, située après await, ne s'exécute pas. Le catch ne peut pas
   neutraliser une activité dont il n'a jamais reçu l'ID. Ni provenance, ni external ID,
   ni décision REVIEW n'a encore été créée pour cette activité.

Dans supabase-persistence.js, beforeCreateActivity reçoit désormais la ligne, les métadonnées,
les comparaisons et la décision AVANT INSERT. Le garde guardExactSignatureReview utilisable
par le pilote contrôlé refuse à cet endroit. Le callback est transmis par le persister DT.
Le transport HTTP ne doit plus refuser une mutation déjà réalisée pour ce type de contrôle.

Toute nouvelle activité commence en stale, REVIEW compris. La promotion au statut cible
active/review vient après provenance et external IDs réussis. Même en cas de réponse INSERT
perdue et d'échec de cleanup, seule une ligne de staging stale peut rester, jamais une nouvelle
activité fonctionnelle sans soutien. Il ne s'agit pas d'une transaction SQL multi-HTTP : cette
limite est explicite. Aucune suppression automatique d'activité existante, aucun conflit masqué.
Le REVIEW normal reste possible ; MATCH/DISTINCT et rejeu sont couverts par régression.

## Nettoyage réel limité au résidu

Dry-run préalable : absent du snapshot avant scan, retrouvé dans la réponse INSERT incriminée,
ligne intégralement identique au snapshot interrompu, zéro provenance même inactive, zéro
external ID, collection item, décision gauche/droite ou activité fusionnée la référençant.
Ces relations ont été relues juste avant mutation. RPC existante
sortir_stale_unsupported_activities, bornée à cet ID unique, avec contrôle SQL de l'absence de
provenance active au moment de l'UPDATE : résultat 1. Aucune ligne supprimée.
La seule différence constatée sur les neuf tables snapshotées est record_status review→stale
et updated_at de cette activité. Toutes les autres lignes sont strictement identiques.

## Horloges et pending erroné

Le curseur/filtre national et l'observation gardent started_at du scan. Chaque nouveau pending
porte selection_now, enregistré atomiquement par la RPC proposée v2. Un rejeu reprend CET
instant. Le pending legacy utilise started_at seulement pour ce pending ; après acquittement,
les nouvelles pages utilisent now du run courant. Des tests vérifient aussi un second crash
sur un nouveau lot et la sélection effective du connecteur avant/après expiration.

La nouvelle migration 2026-10-23-sortir-datatourisme-batch-selection-clock.sql n'est PAS
appliquée. Elle propose une RPC invoker/search_path=public/service_role, FOR UPDATE, une
transaction, comparaison complète du pending et de l'instant, délégation des contrôles
existants, aucune empreinte validée ni acquittement. Tests statiques seulement : validation
PostgreSQL réelle encore à faire avec autorisation. Le nouvel adaptateur utilise v2 sans
fallback silencieux vers l'ancienne horloge.

Le pilote interrompu capturait également now dans son persister et son calcul de métriques :
il ne faut PAS le relancer tel quel. Le futur pilote doit passer context.now à la conversion,
au persister recréé par lot et à la réconciliation, en partageant seulement le cache candidats.

Le pending actuel reste failed, pages=10 / received=1000, pending pages11–20 / count1000,
total62940. Sa correction future est décrite dans datatourisme-failed-checkpoint-recovery.md :
CAS du JSON complet sous verrou, rebase explicite de pending.selection_now=T sans changer
les compteurs/statut, needs_reprocess uniquement sur Drugeot et COREFF avec comparaison de
leurs anciennes références. Leurs empreintes peuvent être déjà correctes alors que des
provenances ont été réintroduites APRÈS validation : sans invalidation, UNCHANGED les masquerait.
Puis nouveau dry-run, réouverture failed→running CAS distincte seulement après accord, archives
inchangées, couverture/reconciliation/références réussies avant acquittement normal.
Aucune de ces mutations de reprise n'a été exécutée.

## Dry-run intégral en mémoire

Référentiel figé : 2026-10-23T14:26:31.139Z. Les dix archives inchangées, le snapshot réel,
le pipeline normal, le staging REVIEW corrigé et le garde pré-INSERT sont utilisés.
Le résidu est projeté stale et les deux needs_reprocess sont projetés true, sans écriture DB.

| Mesure | Résultat simulé |
|---|---:|
| Reçus / calculables / invalides | 1000 / 994 / 6 |
| NEW / CHANGED / UNCHANGED | 986 / 4 / 4 |
| Occurrences sélectionnées | 1380 |
| Créations activités / provenances / external IDs | 1123 / 1123 / 3370 |
| REVIEW normalement persistés hors signatures exactes | 3 |
| Créations Singulières refusées avant INSERT | 29 |
| Références validables hors sous-lot bloqué | 890 |
| POI du sous-lot de 100 non validés | 100 |
| Provenances désactivées / activités stale | 202 / 202 |
| Écritures réelles de ce dry-run | 0 |

La simulation parcourt tous les sous-lots pour inventorier le plan ; elle ne constitue PAS
l'autorisation de poursuivre après un blocage en réel. La reprise réelle doit s'arrêter dès le
premier résultat incomplet. canAcknowledge=false, aucune référence Singulières validée.
Les 221 collection items antérieurs gardent exactement leur provenance/activité ; aucune clé
de provenance dupliquée. Les 179 nouvelles provenances du passage précédent gardent leur ID.
Zéro occurrence passée Drugeot/COREFF active dans l'état simulé, aucune recréation de ces dates.

Les 202 retraits proposés ne sont pas tous dus à l'horloge : 30 sont passés (dont les trois
Drugeot/COREFF), 155 intervalles sont absents des périodes brutes reçues pages11–20, 17 restent
dans le brut mais hors fenêtre de 90 jours, remplacés par le repli sur la seule prochaine
occurrence (deux POI, dates avril/juillet/août2027). Aucun n'est la disparition du POI entier.
Le fichier retirement-analysis.json conserve chaque ancienne référence et la sélection calculée.
Aucun de ces 202 retraits n'a été exécuté en base.

## Inventaire exhaustif des signatures pages 11–20

1000 POI et 3185 périodes brutes examinés, sans nouvelle collecte. Aucun groupe cross-UUID
entre deux POI DU pending. En comparaison avec le stock : un seul couple inter-UUID, Singulières,
30 signatures historiques et 29 encore sélectionnées au now du dry-run. L'ancien UUID est dans
le stock, pas dans ces dix pages. Aucune autre classe de collision détectée dans ce périmètre.

Chaque ligne suivante concerne le couple de UUID ci-dessus. Décision actuelle REVIEW ;
activité liée = ancienne fiche, nouvelle provenance = aucune. La seule création résiduelle
sur le premier intervalle est désormais stale et sans provenance. Cause commune : doublon
éditorial source très fortement établi, absence d'identité partagée dans les IDs du modèle,
puis refus trop tardif du garde du pilote. Les autres intervalles n'ont pas été écrits.

| Début UTC | Fin UTC | Activité déjà liée | Provenance active existante |
|---|---|---|---|
| 2026-11-10T09:00:00.000Z | 2026-11-10T18:00:00.000Z | 7040c329-422b-458d-a4a7-010b1ab8faf7 | 88384285-0f54-4bbb-aabb-ebfeae74404f |
| 2026-10-23T09:00:00.000Z | 2026-10-23T18:00:00.000Z | cf0414e4-c2e7-4db1-9507-3ff1b233593e | 153eba85-44e6-444c-a67b-003ff15ac1ce |
| 2026-10-24T09:00:00.000Z | 2026-10-24T18:00:00.000Z | 0f8eb092-06f7-420e-b23a-bb90adb6ad85 | 6ee33b63-8215-48ed-bfcb-dd7d7e930cad |
| 2026-11-22T09:00:00.000Z | 2026-11-22T18:00:00.000Z | f36e6b4b-e704-482e-9259-69e8021f1fe8 | 414d386f-d8b2-41f1-8e44-e75a6ba16549 |
| 2026-11-04T09:00:00.000Z | 2026-11-04T18:00:00.000Z | 6a810fe4-b54d-43ba-834a-7d79ecf39e47 | 665a5ed8-ec4f-4057-be50-5ed1850c79b9 |
| 2026-11-24T09:00:00.000Z | 2026-11-24T18:00:00.000Z | b32c850b-6202-4de2-9ce8-6cdca364f30e | 3737f443-e713-42b6-a81b-d98819438b3e |
| 2026-11-11T09:00:00.000Z | 2026-11-11T18:00:00.000Z | 451ebcf1-3a5a-471d-ae71-7f80e75bc234 | 475aa0ad-dd3f-4e5f-bcc0-47529b16318a |
| 2026-11-12T09:00:00.000Z | 2026-11-12T18:00:00.000Z | 2bddde7b-0cc3-4964-96ee-1440891da793 | 0d22d083-a027-4a16-b818-92a12c872a5c |
| 2026-11-15T09:00:00.000Z | 2026-11-15T18:00:00.000Z | 09f87009-e86d-4148-8cde-1fb1dd91fac6 | d5cd1f24-34db-4dad-942f-81a38a6c7eab |
| 2026-10-30T09:00:00.000Z | 2026-10-30T18:00:00.000Z | bf0f1a4c-624e-40d2-842d-e2a52d14f0a8 | dc175b93-8ee4-4a34-b158-c32086e35c6b |
| 2026-11-03T09:00:00.000Z | 2026-11-03T18:00:00.000Z | a9409770-0d94-4020-b652-7f7901c6dcaa | 6533d9aa-04ab-48da-bb58-4ac368082b85 |
| 2026-11-21T09:00:00.000Z | 2026-11-21T18:00:00.000Z | 72832e98-5e40-4ec3-b1f9-c18a82788a6e | 4f27ef69-a8b1-45ae-8ce8-ee6d400778d3 |
| 2026-10-27T09:00:00.000Z | 2026-10-27T18:00:00.000Z | 89468315-cdc0-489a-883a-835bd98ef888 | 097a49e6-c73c-4ba0-9d23-7616c147d181 |
| 2026-11-25T09:00:00.000Z | 2026-11-25T18:00:00.000Z | 7c9f859c-dfc5-4fdb-a0ab-c7476bf53a44 | a3055196-6a17-4078-b9ef-a603fcec3d9d |
| 2026-11-05T09:00:00.000Z | 2026-11-05T18:00:00.000Z | 4afb6dd4-4726-4d3d-a94a-c9db75de9ade | 9666dac8-d07e-43ab-9c35-1bdc6f5618fc |
| 2026-11-19T09:00:00.000Z | 2026-11-19T18:00:00.000Z | 71bb1206-13f3-4d81-91d2-814af38c5e3d | 1f35fab6-6502-4b34-b1a1-40dcbb14fdcf |
| 2026-10-28T09:00:00.000Z | 2026-10-28T18:00:00.000Z | 093b7034-ebbb-4346-b186-249b3af5ad81 | 7b0735a3-6fb5-4f5a-becc-d599b3c87ba2 |
| 2026-10-22T09:00:00.000Z | 2026-10-22T18:00:00.000Z | 0c63ca4a-00fc-4674-9a3d-565720853ab0 | ec6e9afa-ffdc-441d-b625-dd574ed47ad3 |
| 2026-11-08T09:00:00.000Z | 2026-11-08T18:00:00.000Z | c4d5a673-deb8-401c-bd31-61b437f61f63 | 56814564-f46b-4c06-b28e-5c20a6d28df4 |
| 2026-11-18T09:00:00.000Z | 2026-11-18T18:00:00.000Z | 4b0305a9-6d45-4e09-b28b-238289f31279 | e2768332-1c16-4702-9a66-f373e687864b |
| 2026-11-07T09:00:00.000Z | 2026-11-07T18:00:00.000Z | 1ad2b7f6-9cae-4dad-96c4-b84073993f2f | 0144b07c-fac0-4478-9285-a1567530b788 |
| 2026-11-06T09:00:00.000Z | 2026-11-06T18:00:00.000Z | 30b89b1a-83af-4cea-8788-513917953ac9 | a20f7e3f-a646-4a6d-b75d-c158deb70a85 |
| 2026-11-17T09:00:00.000Z | 2026-11-17T18:00:00.000Z | 2dccab33-4202-4107-be26-cd66bde4318e | 832b5a36-be2c-441b-a0de-f21731ab771e |
| 2026-11-14T09:00:00.000Z | 2026-11-14T18:00:00.000Z | f607052b-366d-4379-bd3d-fe6bb41a0e1d | fb004eb7-c675-4179-8f2d-87add98b2350 |
| 2026-11-13T09:00:00.000Z | 2026-11-13T18:00:00.000Z | f4f13809-980f-4fc1-92b6-b12f1b206804 | 671702ad-5465-4526-a80c-014f1a6df45b |
| 2026-11-01T09:00:00.000Z | 2026-11-01T18:00:00.000Z | 7f8f5ca6-a774-41bb-a51e-e6cd55263c64 | 08af46ee-02d2-4f10-a361-d7232b7a335b |
| 2026-10-25T09:00:00.000Z | 2026-10-25T18:00:00.000Z | 55201613-4623-4419-b3ea-0fc68d476e68 | 4270a0a2-a910-4e77-a328-2226903f18fd |
| 2026-11-20T09:00:00.000Z | 2026-11-20T18:00:00.000Z | b44a5d7c-fde8-47d3-bbc4-898018af59d4 | a50bd080-9857-4131-9b09-cebcb597b466 |
| 2026-10-29T09:00:00.000Z | 2026-10-29T18:00:00.000Z | fe5a55da-9061-4abb-be2d-c5d236788382 | c3c999a1-520c-4d9a-9111-7cc066a62158 |
| 2026-10-31T09:00:00.000Z | 2026-10-31T18:00:00.000Z | 6ae2c97e-b7af-4626-9569-e2601d36fbe6 | 6217d466-472b-4060-a889-bcdc64f01df4 |

Le détail pour chaque UUID, période brute, source_occurrence_key, comparaison, activité,
provenance et external IDs est dans inventory.json ; raw-inventory.json inclut les périodes
non sélectionnées et l'inventaire intégral des 3185 périodes.

## Intégrité réelle et tests

| Compteur réel | Avant | Après |
|---|---:|---:|
| Activités | 3547 | 3547 |
| Provenances | 3773 | 3773 |
| External IDs | 11269 | 11269 |
| États POI | 2026 | 2026 |
| active | 1044 | 1044 |
| review | 984 | 983 |
| stale | 1515 | 1516 |
| merged | 4 | 4 |
| Activités multisources | 96 | 96 |
| Doublons clés provenances / external IDs | 0 / 0 | 0 / 0 |
| Orphelins relations | 0 | 0 |
| Runs running | 0 | 0 |

Précontrôle après : 1811 provenances DT actives et 2027 activités active/review inspectées.
Aucune activité fonctionnelle sans soutien, aucun groupe de signatures fonctionnel problématique.
Seul reste le mauvais intervalle historique Lever du soleil, conservé strictement inchangé,
sans rendre le précontrôle permissif : ready=false/exit2. Les empreintes et le checkpoint sont
strictement identiques ; SHA-256 du JSON canonique du checkpoint :
`29f49d94ac94c679bc5be75ad5fc7bb62a1aa7baa7ff25d7e07c9a79cfd09e40`.

Suite Sortir complète : **541/541**, 33 scripts, zéro échec. git diff --check propre.

Fichiers touchés dans cette étape : supabase-persistence.js, datatourisme-poi-reconciliation.js,
datatourisme-national-scan.js, datatourisme-preflight.js, datatourisme-failed-checkpoint-recovery.md,
test-datatourisme-batch-checkpoint.js, test-datatourisme-get-preflight.js. Ajouts :
datatourisme-activity-safety.js, test-datatourisme-activity-safety.js,
test-datatourisme-selection-clock-sql.js, migration batch-selection-clock proposée, ce rapport.

HEAD 75299c3, branche main. Travail antérieur et fichiers YouTube conservés. Dépôt non propre
comme au départ ; état complet dans /private/tmp/dt-page13-audit/git-status.txt.
Aucun commit/push, scheduler, OpenAgenda, plafond300 ou optimisation structurelle.

Preuves locales : /private/tmp/dt-page13-audit/ (snapshots avant/après, cleanup dry-run/résultat,
comparaison intégrale des sources, inventaires, dry-run de reprise, contrôles d'intégrité et logs
de chaque script de test). Les preuves d'arrêt originales n'ont pas été écrasées.
