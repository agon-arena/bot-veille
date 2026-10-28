# Correction organizer_name_missing et reprise historique

La correction est limitée à DATAtourisme. Le diagnostic reste NEEDS_REVIEW et est
conservé dans collection_items. Il cesse seulement d'imposer le statut review à
un nouveau DISTINCT si aucune autre alerte ou erreur n'existe. Les décisions
MATCH, leurs seuils et le statut de leur cible sont inchangés. Les autres
connecteurs gardent leur comportement.

## Chemins corrigés

- Création : exception locale dans `supabase-persistence.js`, via
  `organizerWarningNonBlocking` ; un candidat REVIEW reste bloquant et les gardes
  avant création continuent à s'exécuter. Publication après provenance uniquement.
- Reprise d'un staging stale / réapparition mono-provenance : même exception,
  précédée du contrôle des quarantaines et d'une nouvelle comparaison des
  candidats. Tout MATCH ou REVIEW concurrent reste bloquant, sans fusion.
- Après une panne avant les external IDs, leur réparation déjà existante doit
  aussi alimenter l'index mémoire : sinon le rejeu confond deux séances d'un POI
  dont les identifiants venaient seulement d'être restaurés.
- Une provenance connue pointant vers une activité déjà review conserve ce statut
  au replay normal, même si son contenu change. Aucune reprise historique implicite
  des REVIEW n'a été ajoutée.
- Les erreurs de validation restent INVALID et sont rejetées avant stockage :
  elles ne sont pas transformées artificiellement en REVIEW.

Aucun changement au validateur, comparateur, zonage, règles de périodes,
fingerprints POI, scheduler ou filtre éditorial Explorer.

## Outil actuellement disponible : dry-run hors ligne uniquement

`run-organizer-review-dry-run.js` n'importe aucun store d'écriture, ne charge pas
les credentials et n'a volontairement aucun mode `--apply`. Aucun changement
Supabase, ingestion ou appel fournisseur n'est nécessaire. Les seuls fichiers
écrits sont ses résultats locaux.

```sh
node --max-old-space-size=4096 sortir/run-organizer-review-dry-run.js \
  --snapshot-dir /chemin/snapshot-lecture-seule \
  --output-dir /chemin/resultats-nouveaux \
  --batch-size 100
```

Options : `--ids-file liste.json` pour le pilote, `--max-batches 2` pour simuler une
interruption, puis `--resume` avec les mêmes options. `--as-of ISO` permet un nouvel
instant explicite ; il exige un autre dossier de sortie. Sans option, l'instant
est celui du snapshot, et non une fausse mesure de la production actuelle.

Format : activités/provenances/external IDs/collection_items et compteurs de la
photographie, sources, décisions, périodes source, éventuellement payloads plats
anciens. Le chargeur contrôle les tailles attendues et refuse les relations
orphelines. Le snapshot doit être exhaustif, paginé sans doublon et issu d'une
lecture stable ; le dry-run ne remplace pas ces contrôles d'acquisition.

Le manifeste lie SHA-256 du snapshot, du code, de l'instant et de la sélection.
Les lots de 1 à 500 dossiers sont triés par ID et enregistrés atomiquement
(temporaire puis rename). Les checkpoints contiennent les décisions individuelles,
leur motif et la position ; la reprise reconstruit les compteurs sans les doubler.
Un changement de code/snapshot/options invalide la reprise plutôt que réutiliser
un résultat périmé. Les résultats locaux ne constituent jamais une autorisation
ni une preuve suffisante pour écrire en base.

Compteurs : examinés, **wouldActivate** (jamais « activés » en dry-run), restés
REVIEW, erreurs, quarantaines, autres ambiguïtés, déjà actifs, hors périmètre,
déjà traités à la reprise et écritures base (= 0).

## Réévaluation historique

Le module `organizer-review-recovery.js` utilise la même exception de validation,
`rowToActivity`, `compareActivities`, l'index temporel et la quarantaine existants.
Il ne crée ni activité, ni provenance, ni external ID et n'exécute aucune fusion.

Une promotion ne peut être proposée que si :

1. un diagnostic enregistré contient organizer_name_missing ;
2. le statut actuel est review, l'activité est en cours/future et son lifecycle
   est publiable ;
3. aucune quarantaine pending, y compris ancienne sans marqueur, ne la protège ;
4. des provenances actives DATAtourisme soutiennent la ligne ;
5. la revalidation ne contient que organizer_name_missing, sans erreur ;
6. les périodes source concordent avec l'intervalle stocké ; formats v2 et plats
   anciens reconnus, données manquantes conservées en REVIEW ;
7. chaque identité d'occurrence a sa provenance : identifiants actuels et anciens
   alias explicitement appuyés par source_record_id + intervalle ;
8. chaque autre candidat renvoyé par l'index est DISTINCT. Un MATCH historique
   éventuel est retenu pour résolution, jamais fusionné automatiquement.

La géographie et le temps sont évalués par le validateur et le comparateur
existants ; aucun seuil n'est changé. La publicabilité Explorer est un contrôle
supplémentaire : une occurrence avec un code géographique refusé par Explorer
ne gagne pas une carte par simple changement de statut.

## Protocole d'écriture proposé — à implémenter/autoriser séparément

Le présent outil est un préparateur vérifiable, **pas un writer de production**.
Aucun SQL massif review → active et aucune migration n'ont été ajoutés.

1. Autorisation distincte du pilote réel (liste d'IDs fermée, code et manifeste
   figés). Vérifier l'exclusion de tout writer concurrent Sortir/DATAtourisme/
   OpenAgenda pendant la fenêtre ; ne pas modifier la définition du scheduler.
2. Relire les lignes, provenances/payloads, identifiants, diagnostics, décisions et
   tous les candidats actuels depuis Supabase. La photographie d'audit ne suffit
   pas pour une écriture ultérieure. Capturer une révision/hash des entrées.
3. Recalculer la même éligibilité à la date réelle d'exécution. Ne jamais appliquer
   aveuglément les PROMOTE d'un ancien résultat ou une liste d'IDs nationale.
4. Pour chaque dossier, sous une transaction avec verrou de ligne et exclusion
   garantie des autres writers, recontrôler les révisions et quarantaines puis
   changer seulement record_status/updated_at si la ligne est toujours review et
   si toutes les preuves sont inchangées. Le mécanisme transactionnel/adapter
   sera un livrable du writer ; aucun endpoint ou RPC inexistant n'est présumé.
5. Journal durable par (version de règle, activité, hash d'entrée) : avant/après,
   motif, preuves/candidats et résultat confirmé. Transactionner le journal avec la
   promotion, ou réconcilier les réponses perdues par relecture avant checkpoint.
   Jamais de rollback aveugle d'une ligne modifiée depuis par un autre acteur.
6. Checkpointer seulement les résultats confirmés. Une interruption avant
   confirmation donne une relecture, pas une promotion répétée. Une ligne déjà
   active n'est pas réécrite ; une entrée changée est réévaluée, pas sautée à tort.
7. Invariants avant/après pilote : mêmes activités/IDs de lignes, mêmes relations,
   external IDs, payloads, dates/lieux et regroupements ; seuls les statuts
   explicitement autorisés peuvent changer. Contrôler Explorer avec son moteur
   réel et ses pages, pas avec le nombre d'occurrences.
8. Arrêter sur erreur d'intégrité, conflit de version/concurrence ou promotion
   imprévue. Les REVIEW sensibles restent telles quelles. Publier les compteurs
   puis attendre la validation du pilote réel avant une autorisation nationale
   distincte. Lots nationaux proposés : 100, checkpoint et contrôle par lot.

Les garanties transactionnelles du writer réel devront être testées avant son
exécution. Les tests hors ligne actuels démontrent l'éligibilité, la stabilité du
plan et les reprises locales ; ils ne prétendent pas démontrer une transaction
Supabase qui n'a pas été implémentée.

## Validation

Tests dédiés :

```sh
node sortir/test-organizer-review-policy.js
node sortir/test-organizer-review-recovery.js
node sortir/test-datatourisme-reactivation.js
node sortir/test-datatourisme-write-behind.js
```

La suite existante a été exécutée intégralement hors réseau (42 fichiers).
Les tests de réactivation n'attendent plus REVIEW lorsque le seul avertissement
est désormais non bloquant. L'assertion de publication après panne vérifie qu'une
couverture partielle appartient entièrement à une seule identité active de
référence ; les sources inconnues et mélanges entre identités sont refusés. La
convergence complète des activités, provenances, external IDs, décisions et états
après rejeu demeure vérifiée.

Les résultats mesurés et les commandes exactes de simulation/pilote figurent dans
`organizer-review-correction-report.md`. Aucune reprise réelle n'est autorisée par
la seule réussite de ces tests.
