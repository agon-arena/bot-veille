# Correction organizer_name_missing — validation et préparation historique

**CORRECTION VALIDÉE — REPRISE HISTORIQUE PRÊTE À ÊTRE AUTORISÉE**

Cette validation porte sur la correction du code, la simulation nationale et le
préparateur dry-run. **Aucune promotion réelle, ingestion, migration, appel
fournisseur ou modification du scheduler n'a été exécuté.** Aucun commit/push.
Le writer de production est une étape distincte à implémenter et autoriser selon
le protocole décrit dans [le plan de reprise](organizer-review-recovery-plan.md).
L'outil livré refuse --apply ; cette mention de validation ne l'autorise pas à écrire.

## 1. Fichiers

- supabase-persistence.js : création DISTINCT et reprise rare d'un staging/stale.
- organizer-review-policy.js : exception éditoriale exacte, DATAtourisme seulement.
- organizer-review-recovery.js : réévaluation historique pure, aucune écriture.
- run-organizer-review-dry-run.js : snapshot hors ligne, lots/checkpoints, reprise.
- test-organizer-review-policy.js : 22 régressions d'intégration/politique.
- test-organizer-review-recovery.js : 16 tests d'éligibilité, sécurité et checkpoints.
- test-datatourisme-reactivation.js : attentes corrigées pour l'avertissement seul.
- test-datatourisme-write-behind.js : contrôles de panne et couverture partielle.
- organizer-review-recovery-plan.md : conception précise du futur traitement réel.
- organizer-review-validation-results.json : résultats structurés des 42 suites,
  de la simulation et du pilote.
- organizer-review-correction-report.md : présent rapport.

## 2. Avant / après

Avant, sous réserve des erreurs INVALID déjà rejetées :

```js
const underReview = validation.status === "NEEDS_REVIEW" || reviews.length > 0;
```

Après :

```js
const underReview = (validation.status === "NEEDS_REVIEW" &&
  !organizerWarningNonBlocking(validation, source.connector_type)) || reviews.length > 0;
```

L'exception exige DATAtourisme, NEEDS_REVIEW, zéro erreur et exclusivement des
avertissements organizer_name_missing. Une URL sans nom est conservée, de même
qu'une liste contenant un nom et une autre entrée URL sans nom. Le validateur,
les diagnostics et les URLs ne sont pas modifiés. Les autres connecteurs restent
hors de cette exception. Une liste vide reste traitée comme avant.

Les décisions et seuils MATCH restent identiques. Un MATCH conserve le statut de
sa cible. Les contradictions entre organisateurs nommés, géographiques et
horaires restent traitées par le comparateur inchangé. Les erreurs de validation
restent INVALID/rejetées avant stockage : elles n'ont pas été converties en REVIEW.

Les tests de panne ont rendu nécessaire d'appliquer la même politique lors de la
réactivation mono-provenance d'un staging/stale : quarantaine d'abord, puis lecture
explicite de la fenêtre de candidats et refus si un autre candidat n'est pas
DISTINCT. Le préchargement des seules provenances connues ne garantit pas un index
rempli. Les identifiants réparés après panne alimentent aussi l'index mémoire.
Aucune fusion supplémentaire n'est effectuée sur ce chemin.

**Conséquence précise :** une activité stale mono-provenance auparavant bloquée
uniquement par le nom manquant peut redevenir active au retour de sa source,
seulement après ces contrôles. Une activité déjà review, provenance connue,
conserve review lors d'un replay normal, contenu identique ou modifié. Aucune
promotion des REVIEW historiques n'est cachée dans l'ingestion normale.

## 3. Tests

**42 suites intégralement exécutées hors réseau, 692 cas réussis, 0 échec.**
Syntaxe JavaScript et git diff --check valides. Le JSON de résultats détaille
chaque suite, son statut et son nombre de cas. Les connecteurs, le comparateur,
le cache, les quarantaines, la réconciliation, les checkpoints, les identifiants,
les écritures différées et les chemins connus font partie de cette exécution.

Nouveaux cas : DISTINCT avec contacts sans nom ou organisateur nommé + contact
sans nom ; diagnostic conservé ; absence totale ; autre avertissement ; erreurs,
latitude invalide et fin avant début ; ambiguïtés de titre, géographie, précision
horaire, organisateurs contradictoires ; MATCH vers active/review ; séances
matin/après-midi ; triple rejeu ; REVIEW historique préservée ; quarantaine/stale ;
relecture des candidats en reprise ; erreur avant provenance ; hors connecteur ;
source/période incohérente ; ancien alias prouvé ; identifiant injustifié ; absence
de soutien ; annulation ; déjà actif ; checkpoints interrompus et double resume ;
changement snapshot/date refusé ; doublons/orphelins refusés ; --apply refusé.

Les métadonnées d'observation last_seen_run_id peuvent évoluer au rejeu normal :
l'idempotence vérifie les identités, relations, payloads, périodes et statuts,
pas l'égalité artificielle d'un numéro de run.

Les attentes des tests de réactivation ont été ajustées au nouveau contrat pour
le seul avertissement non bloquant. Dans le test de panne, l'ancienne égalité de
clé concaténée des provenances assimilait à tort une identité canonique seulement
partiellement rattachée à une publication inconnue. Le contrôle exige désormais
que toutes ses provenances appartiennent à UNE identité active de référence ; un
mélange de deux identités ou une source inconnue est explicitement testé/refusé.
La convergence complète après rejeu reste obligatoire. **39 tests write-behind
réussissent**, toutes phases de panne incluses.

## 4. Recalcul national après correction

Snapshot immuable de l'audit : **28/10/2026 17:38:11 UTC / 21:38:11 Réunion**.
Il s'agit d'une reproduction sur les données de cet audit, pas d'une nouvelle
mesure live au moment d'un futur déploiement.

| Mesure | Attendu audit | Mesuré après correction |
| --- | --- | --- |
| Occurrences concernées | 35 899 | 35 899 |
| Comparaisons | 8 361 174 | 8 361 174 |
| DISTINCT libérables | 35 269 | 35 269 |
| Toujours REVIEW | 630 | 630 |
| Nouveaux MATCH | 0 | 0 |

Écart **zéro**, y compris décision par décision sur les 35 899 IDs. Les 630 restent
368 quarantaines, 253 ambiguïtés du comparateur et 9 autres validations. Les
646 REVIEW sans ce diagnostic restent hors périmètre. Le nombre 35 890 signifie
« seul avertissement de validation », et non absence de toute quarantaine.

Le moteur complet a été recalculé pendant cette intervention. Après les derniers
ajustements d'intégration, vérification supplémentaire de la même politique sur
les 35 899 lignes : 35 890 avertissements seuls. Le corps rowToActivity est
identique à HEAD ; validateur, comparateur, index et quarantaine ont leurs SHA-256
inchangés. Les changements de staging/réactivation n'interviennent pas dans cette
simulation d'identité/publicabilité des REVIEW ; leurs tests d'intégration ont
été exécutés sur le code final.

La projection exhaustive du panel reste donc celle validée : **283 → 1 739 cartes**,
soit +1 456, sous réserve d'une reprise réelle autorisée et d'un nouvel instant.
Ce n'est pas le résultat du petit lot de 75 ci-dessous et ce ne sont pas des
cartes déjà publiées.

## 5. Pilote dry-run représentatif

**75 REVIEW** : 10 DISTINCT admissibles dans chacune des cinq villes demandées,
10 quarantaines, 10 ambiguïtés comparateur et 5 autres validations. L'ensemble de
l'index national est utilisé comme candidats ; le pilote n'est pas comparé
seulement à lui-même.

| Compteur | Avant | Projection après |
| --- | --- | --- |
| Activités | 75 | 75 |
| Provenances | 75 | 75 |
| External IDs | 230 | 230 |
| REVIEW | 75 | 25 |
| ACTIVE | 0 | 50 |
| Écritures en base | 0 | 0 |

Les 50 ACTIVE sont **proposées uniquement en mémoire**. 25 restent REVIEW,
0 erreur. Tous les identifiants/provenances, intervalles et payloads restent
identiques. Empreinte des entrées avant/après identique.

Interruption après deux lots de 10, reprise jusqu'au bout puis nouvelle reprise :
mêmes 75 décisions ; deuxième reprise = 75 déjà traités. Aucun résultat en double.
Les changements de code/snapshot/options invalident un checkpoint. Les tests
unitaires couvrent aussi déjà actif, erreur et rejet des entrées hors périmètre.

| Ville | Cartes locales avant | Promotions proposées | Cartes après simulation du petit lot |
| --- | --- | --- | --- |
| Paris | 0 | 10 | 10 |
| Lyon | 0 | 10 | 9 |
| Marseille | 11 | 10 | 21 |
| Toulouse | 47 | 10 | 56 |
| Strasbourg | 0 | 10 | 8 |

Le regroupement et la pagination réels Explorer ont été exécutés hors réseau.
Les autres villes du panel restent inchangées dans ce petit lot. Le second calcul
sur les mêmes statuts simulés donne exactement les mêmes cartes/regroupements.

## 6. Reprise historique : livrable et limites

Le CLI dry-run est opérationnel, batché et reprenable. Le module pur cible le
diagnostic enregistré, revalide l'activité, les soutiens actifs, périodes et
identifiants, vérifie les quarantaines et compare les candidats avec le moteur
existant. Il refuse les MATCH historiques : aucune fusion automatique.

Les résultats nationaux ci-dessus viennent de la simulation exhaustive du moteur.
**Le CLI de préparation historique a été validé sur le pilote de 75**, pas présenté
comme une reprise nationale réelle ni comme un writer transactionnel déjà testé.

Le [plan de reprise](organizer-review-recovery-plan.md) précise : lot initial
fermé, exclusion des writers concurrents, relecture live de toutes les preuves,
transaction/verrous et contrôle de version avant chaque promotion, journal durable,
relecture après réponse perdue, checkpoint seulement après confirmation, invariants
avant/après et autorisation nationale séparée après validation du pilote réel.
Le writer réel et son adapter transactionnel restent à implémenter/tester sous
une autorisation distincte ; aucun UPDATE massif ou RPC fictif n'est livré.

Compteurs prévus : examinés, passés ACTIVE confirmés (wouldActivate en dry-run),
restés REVIEW, erreurs, quarantaines, autres ambiguïtés, déjà actifs et déjà traités.
Pas de téléchargement DATAtourisme nécessaire : priorité aux payloads conservés ;
une preuve insuffisante reste REVIEW.

## 7. État Git et périmètre

Branche **main**, HEAD **87f74c1b2b0ff4f69b8c0d4c60c59d49474f37ae** inchangé.
Aucun commit, push ou staging. Trois fichiers suivis modifiés : persistence,
test-datatourisme-reactivation et test-datatourisme-write-behind. Huit nouveaux
fichiers non suivis : policy, recovery, CLI, deux tests, plan, rapport et résultats.
Onze fichiers au total dans le diff final. Aucun fichier utilisateur préexistant
n'était modifié au début de l'intervention.

Aucune régression détectée après les corrections des chemins de panne. Aucune
règle MATCH/géographique/temporelle modifiée. Aucun changement de catégorie,
source, scheduler ou Paris Data. Production inchangée pendant cette intervention :
aucun client d'écriture n'a été appelé.

## 8. Preuves et reproduction

Résultats durables : [JSON complet](organizer-review-validation-results.json).
Logs détaillés et photographie de travail locale :
/tmp/organizer-correction-20261028 et /tmp/explorer-organizer-review-20261028.
Ces dossiers temporaires ne sont pas des dépendances runtime ni des fixtures
obligatoires pour exécuter les tests unitaires ajoutés.

Commande du pilote (même sélection et même code pour interruption/reprise) :

```sh
node --max-old-space-size=4096 sortir/run-organizer-review-dry-run.js \
  --snapshot-dir /tmp/explorer-organizer-review-20261028 \
  --output-dir /tmp/nouveau-pilote-organizer \
  --ids-file /tmp/organizer-correction-20261028/pilot-ids.json \
  --batch-size 10 --max-batches 2
# Reprendre avec les mêmes options, sans --max-batches et avec --resume.
```

**CORRECTION VALIDÉE — REPRISE HISTORIQUE PRÊTE À ÊTRE AUTORISÉE**
