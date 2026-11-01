# Réparation scheduler et nouveau pilote DATAtourisme de 75 occurrences

## Verdicts indépendants

**SCHEDULER CORRIGÉ ET TESTÉ : NON**

Le code est corrigé et les tests hors production passent. Ce NON réserve la réparation opérationnelle complète : **la présence et l’activation de OPENAGENDA_PUBLIC_KEY dans le service Render ne sont pas confirmées**. Aucun accès Render authentifié, CLI ou jeton Render n’est disponible dans cette session. Aucune configuration distante ni mise en production n’a été faite ; le code et le workflow modifiés restent locaux, conformément à l’absence de commit/push. Il serait faux d’affirmer que les huit producteurs fonctionnent maintenant dans le service déployé.

**PILOTE DATATOURISME 75 PRÊT POUR AUTORISATION : OUI**

Nouveau snapshot, quatre remplacements, nouveau plan scellé, dry-run complet et relecture réelle des 75 empreintes réussis. Ce verdict **n’autorise aucune promotion**. Une future exécution doit encore recevoir votre autorisation explicite et revalider l’état sous verrou.

Aucune ingestion réelle déclenchée, promotion historique, migration ou écriture Supabase pendant cette intervention. Les écritures des tests sont limitées à des stores mémoire et à PostgreSQL local isolé. Aucun secret affiché, copié dans le code ou commité.

## 1. Causes exactes des huit échecs

### Trois producteurs Senlis

Le journal du cycle naturel du 30 octobre prouve un arrêt sur la garde apiKey obligatoire avant requête events. Le code transmet process.env.OPENAGENDA_PUBLIC_KEY. La valeur n’était pas disponible/non vide au point d’appel dans ce processus. La clé locale existe, mais le fichier .env local n’est pas une configuration du service Render.

### Cinq producteurs Réunion

L’ancien loadAgendaSchema envoyait directement headers={key:apiKey}, sans vérifier la clé. Avec une valeur undefined, fetch transmet l’en-tête key sous la forme undefined. Les cinq appels s’arrêtaient sur HTTP 403 lors de la lecture des configurations, avant collecte d’événements.

Diagnostic HTTP ciblé, sans persistance :
- **24 GET de configuration** : pour chacun des huit agendas, absence de clé→403, clé invalide→403, clé locale valide→200 et schema présent.
- **5 GET reproduisant exactement l’en-tête undefined** des agendas Réunion : **5 HTTP 403**.
- **8 GET events avec la clé valide, taille demandée 1** : **8 HTTP 200**, format events correct. Aucun événement converti, ingéré ou persisté par ces sondes.

Les mêmes endpoints fonctionnent avec la clé valide ; aucun refus de lecture propre aux cinq agendas ni erreur d’URL n’est observé. Les preuves du processus (clé absente pour Senlis, même variable lue pour Réunion) et la reproduction HTTP expliquent les deux manifestations d’une configuration manquante, **après vérification séparée**, sans supposition initiale d’une cause commune. Les logs ne distinguent pas valeur absente et chaîne vide ; aucune valeur distante secrète n’a été lue.

## 2. Corrections du code et de la configuration

- Nouveau **sortir/openagenda-auth.js** : validation commune d’une clé non vide, retrait des espaces, codes OPENAGENDA_KEY_MISSING / OPENAGENDA_FORBIDDEN / OPENAGENDA_UNAUTHORIZED, statut HTTP explicite. Une clé absente est détectée avant tout appel réseau, pour Senlis comme pour Réunion.
- Les connecteurs events et configuration utilisent cette validation. Les corps HTTP amont, susceptibles de refléter des secrets, ne sont plus recopiés dans les erreurs persistées.
- Nouveau **sortir/check-openagenda-configuration.js** : diagnostic de déploiement strictement en lecture seule sur les huit configurations ; aucune importation/appel du scheduler ou du store d’écriture. Il signale une clé absente et les droits refusés, sans afficher la clé.
- Redaction des secrets connus et des paramètres d’authentification dans les messages génériques avant journalisation.

**Configuration distante restant nécessaire** : ouvrir le service bot veille dans Render → Environment et vérifier la variable exacte OPENAGENDA_PUBLIC_KEY, puis y configurer la clé validée si nécessaire. Aucun mot de passe ou jeton ne doit être envoyé dans le chat. Vous avez demandé où consulter cette configuration ; les indications ont été fournies, mais aucun résultat de vérification distante n’a encore été reçu.

Render permet Save only, sans déployer, mais cette valeur ne devient active qu’au prochain déploiement : https://render.com/docs/configure-environment-variables . Ni ce déploiement, ni une ingestion de validation en production n’ont été réalisés. Le validateur read-only devra être exécuté dans l’environnement réel lors de l’activation autorisée.

## 3. Résultats des cycles observables sans HTTP d’ingestion ouvert

Le tick conserve sa réponse courte **started**, avec **cycleId**, statusPath et successConfirmed=false. Il ne prétend jamais que la collecte est terminée.

Un run enveloppe **sortir-scheduler-cycle-v1** est créé dans la table existante sortir_ingestion_runs. Aucune colonne ou migration ajoutée. Son status et finished_at portent l’état durable ; error_summary contient une entrée explicitement typée kind=sortir_scheduler_cycle avec :
- producteurs attendus et résultats par producteur ;
- completedCount, failedCount, partialCount, pendingCount ;
- statut final completed / partial / failed ;
- causes, codes d’erreur, HTTP, identifiants des runs, dates et compteurs ;
- éventuelle erreur de journalisation/libération du verrou.

Les journaux existants de chaque source et chaque run producteur sont conservés, enrichis des identifiants et codes d’erreur. La progression du cycle est persistée après chaque producteur et son résultat final après libération du verrou. Une erreur d’un producteur n’empêche pas le traitement des suivants ou de DATAtourisme.

Nouveau **GET /api/sortir-ingest-status?cycleId=...**, protégé par requireMixteAuth : lecture d’une seule ligne par clé primaire, délai de lecture borné à 10 secondes. Aucun appel d’ingestion. Il distingue running de finished et recalcule les compteurs ; journal manquant/incohérent ou lecture impossible→aucun succès confirmé. Un processus arrêté laisse running durable ; aucune expiration ou récupération automatique dangereuse.

Le workflow local consulte ce statut par requêtes courtes, pendant au maximum 150 secondes. Il ne déduit plus le succès de HTTP 200 started. Un état partiel/échoué provoque un échec du contrôle ; un état toujours running à l’échéance est **non confirmé**, sans interrompre le traitement. Un tick not due est signalé comme absence de nouvelle ingestion, jamais comme réussite de collecte. Checkout en lecture seule, sans persistance de credential. Cron et heure 04:00 Réunion inchangés.

Cette modification du workflow **n’est pas en ligne**, puisqu’aucun commit/push n’est autorisé. La livraison irrégulière des ticks GitHub reste un sujet séparé : aucun contournement de cron n’a été ajouté.

## 4. Tests hors production

Résultats mesurés :
- **49 suites générales Sortir/scheduler, 797 cas réussis**, aucune suite en échec ; réseau de collecte interdit pendant ces suites.
- **33 tests ciblés finaux réussis, zéro échec**, après les derniers ajustements de journalisation et de timeout. Ils chevauchent les suites générales et ne sont pas additionnés à celles-ci.
- **25 tests PostgreSQL natifs réussis, zéro échec, zéro ignoré**, base loopback isolée : atomicité, rollback, interruption, reprise, idempotence, RLS, visibilité et concurrence réelle entre sessions.
- Syntaxe Node et YAML du workflow vérifiées.

Cas explicitement couverts : clé valide transmise en header aux deux endpoints ; clé absente/blanche sans réseau ; 403 isolé et sans fuite de corps/clé ; sept producteurs poursuivis après un échec ; huit absences de clé journalisées sans faux succès ; distinction started/completed ; résultat relisible par un nouveau lecteur ; checkpoint de cycle incohérent refusé ; état running durable jamais transformé en succès ; panne du journal conservatrice ; endpoint authentifié, lecture seule et réponse rapide ; masquage de secrets ; continuation DATAtourisme après échec OpenAgenda ; verrou partagé conservé ; protection géographique et coïncidences légitimes.

Les GET de diagnostic source avec la clé locale prouvent l’accès API, **pas une ingestion de production réussie**. Aucun test réel d’ingestion n’a été lancé.

## 5. Verrou et état de production

Contrôle en lecture seule à **2026-10-30 03:14:24.730937+00**, soit 07:14 Réunion :
- verrou partagé be127190-19a4-4f50-b615-7a9a78b8ff14, version sortir-scheduler-lock-v1 : **completed** ;
- **0 ingestion running, 0 source run running, 0 lot historique** ;
- **79 571 activités, 80 287 provenances, 240 283 external IDs** ;
- statuts : **38 342 active, 39 490 review, 1 735 stale, 4 merged**.

Empreintes complètes des trois tables métier identiques à celles d’avant l’intervention. Aucune fonction SQL, ACL ou politique RLS modifiée. Le writer continue d’utiliser la fonction de production et ses dix verrous PostgreSQL ; le scheduler réserve toujours la même ligne technique. Le nouveau run enveloppe reste couvert par le contrôle de tous les runs running. Les preuves de concurrence de production antérieures restent applicables à cette fonction inchangée, complétées par les 25 tests natifs actuels.

## 6. Snapshot frais et nouveau plan

Snapshot autoritatif : **sortir/recovery-data/2026-10-30-repair/snapshot-v2/**, instant **2026-10-30T03:02:46.301Z**, transaction unique REPEATABLE READ READ ONLY, TLS vérifié. Il contient le contexte INSEE des périodes nécessaire aux nouveaux contrôles. Une première capture sans ce contexte est conservée dans snapshot/ mais n’est pas utilisée par le nouveau plan. SHA-256 par fichier et snapshotKey scellé ; aucun ancien snapshot /tmp réutilisé.

Ancien plan conservé sans modification : b866b229d2079a0c70bbd6799ffeb61e4ff726542fcd609cda084cc3abd84118.

**Nouveau plan** : sortir/recovery-data/2026-10-30-repair/pilot-sealed-plan.json.

**PlanHash : 20b2a6feb4bac1aeee3c2a7b6082e9898a62edeebc15d4e004ec84622fda5764**.

CodeHash : **bd3d2f669c33ba75c9bc48ec5d71943178476a0a4b46c75238a005359c57b8b5**.
SnapshotKey : **a8e79c8d744428b1363ff55b85406f2373bb2ff8bd1ae94583d327f86c416c2d**.

**71 dossiers conservés, 4 exclus et 4 remplacements**, toujours 75 occurrences dans dix communes. Remplacements :

| ID | Événement à Marseille | Code postal source conservé |
|---|---|---|
| d1924aa2-0ebe-4ecc-8403-4250ec18e873 | HeroFestival Marseille Saison XII | 13008 |
| 719032b6-b723-40a2-a3f2-95d3ba198c49 | Alice in Wonderland | 13008 |
| ddc337c8-9681-4537-9d0b-27f8ccc4499a | SAVIM d'automne salon des vignerons et de la gastronomie | 13008 |
| f634203d-64e4-4b62-a78d-0b3c89b7d1fc | Salon Studyrama Etudes Supérieures | 13008 |

Chaque remplacement est DATAtourisme, REVIEW, DISTINCT, sans autre validation bloquante/quarantaine, avec périodes concordantes, source INSEE et code postal cohérents et acceptation par le zonage Explorer. Les quatre Jazz sur la ville exclus sont toujours REVIEW et leur géographie n’a pas été modifiée.

Les 75 ont été vérifiés individuellement dans pilot-preparation.json. Un cas CEDEX existant, **13616 pour l’Auditorium du Centre Hospitalier d’Aix**, a été contrôlé séparément : la FHF confirme l’adresse de cet établissement en 13616 Aix-en-Provence cedex 1 (https://etablissements.fhf.fr/annuaire/establishment/structure292-establishment4126). Ce code n’a pas été remplacé ni rejeté à tort parce qu’absent de la liste des codes postaux ordinaires. Cette preuve spécifique est consignée par dossier.

## 7. Dry-run et relecture réelle du nouveau pilote

Dry-run complet : **75 examinées, 75 PROMOTE simulées, 0 REVIEW, 0 quarantaine, 0 ambiguïté, 0 erreur, 0 écriture**.

Relecture réelle à **2026-10-30T03:10:39.541Z**, transaction READ ONLY et TLS vérifié : **75/75 empreintes conformes**, décisions recalculées sur **19 067 candidats**, **20 307 comparaisons**. **75 provenances et 225 external IDs**, aucune identité, relation, intervalle ou donnée immuable modifiée en simulation. Prérequis de concurrence satisfaits.

Les empreintes du writer incluent désormais timezoneContext ; les fichiers de la politique géographique et la watchlist entrent dans codeHash. Un changement de cette preuve source ou du code ne peut donc pas passer silencieusement sous l’ancien plan.

Regroupement Explorer : projection des 79 571 lignes identique au snapshot ; **65 groupes théoriques supplémentaires pour 75 occurrences**, avant pagination. La différence est le regroupement d’affichage existant des séries, sans fusion des séances en base. Contrôle géographique individuel : **75 conformes**, dont le CEDEX justifié ci-dessus. Aucune carte n’a été publiée.

## 8. Les 43 anomalies nationales

Fichier durable identifiable : **sortir/data/datatourisme-geographic-review-watchlist.json**, 43 IDs / 15 POI, code postal, INSEE, commune et statut observé.

État historique inchangé, confirmé dans le snapshot frais : **28 active, 15 review**. Les 15 REVIEW sont refusées par le writer historique avec reason=geography_insee_as_postal, même si un payload ancien manque de contexte géographique. Aucun des 43 IDs n’appartient au nouveau pilote.

### Correction minimale du connecteur, appliquée au code local et testée

Politique distincte sortir/datatourisme-geography-policy.js, avec index local attribué au référentiel La Poste/Explorer et communes parentes COG. Quand le postalCode source est égal à l’INSEE source et n’est pas un code postal ordinaire reconnu pour ce code commune, le connecteur **conserve exactement la valeur**, ajoute une preuve explicite datatourisme_insee_as_postal_code et met fieldConfidence.postalCode à 0.5. La validation existante impose alors NEEDS_REVIEW ; la dérogation organizer_name_missing ne suffit plus à rendre ce dossier publiable automatiquement.

Les 20 coïncidences légitimes constatées restent admises. Aucun INSEE n’est transformé en code postal. Aucun intervalle, identifiant, rapprochement ou seuil de comparaison DISTINCT modifié. Le contexte INSEE est hydraté dans les snapshots et contrôlé par la reprise historique. Les tests reproduisent le rejeu d’un nouveau POI erroné et le refus des 43 identités connues.

Cette protection n’est **pas déployée** dans le scheduler distant. Les 28 dossiers déjà active n’ont pas été rétrogradés ni masqués dans Explorer : cela demanderait une action historique ou applicative distincte. Le présent travail empêche leur libération par le writer local et prépare la prévention des nouvelles erreurs après activation du code ; il ne prétend pas avoir nettoyé la production.

## 9. Risques résiduels et suite

- Configuration active Render non confirmée et code/workflow non déployés. C’est le seul obstacle à un verdict de réparation opérationnelle complète du scheduler ; les lectures locales avec clé valide et les tests passent.
- Le polling CI est borné : un cycle très long peut finir après l’échéance du contrôle. Son état reste consultable ; il est alors non confirmé, jamais faussement réussi.
- Crash après réservation durable running : contrôle opérateur nécessaire, sans expiration automatique. Une panne de journal conserve également un état conservateur.
- Référentiel postal ordinaire non exhaustif pour les CEDEX : la protection met en revue plutôt que de corriger une valeur ; un éventuel faux positif doit être examiné. Elle ne constitue pas un audit géographique universel des payloads sans INSEE. Les cas déjà identifiés restent couverts par la watchlist.
- Les 28 anomalies déjà actives restent telles quelles sous l’interdiction de modifier l’historique ; leur traitement séparé reste à autoriser.
- Toute modification future du code, de la politique, des sources ou des dossiers exige revalidation avant le lot réel. L’exécution du pilote reste expressément interdite à cette étape.

## 10. Fichiers et Git

Fichiers de cette étape :
- .github/workflows/auto-collect.yml ; server.js ; sortir-auto-ingest.js ;
- sortir/openagenda-auth.js ; sortir/connectors/openagenda-json.js ; sortir/openagenda-reunion-daily.js ;
- sortir/scheduler-cycle-status.js ; sortir/check-scheduler-response.js ; sortir/check-openagenda-configuration.js ;
- sortir/datatourisme-geography-policy.js ; sortir/data/insee-not-postal-codes.json ; sortir/data/datatourisme-geographic-review-watchlist.json ;
- sortir/connectors/datatourisme.js ; sortir/organizer-review-recovery.js ; sortir/organizer-review-writer.js ; sortir/run-organizer-review-dry-run.js ;
- sortir/test-scheduler-repair.js ; sortir/test-datatourisme-geography-policy.js ; présent rapport.

Les autres modifications et fichiers non suivis préexistaient et sont conservés. Aucun fichier de migration modifié ou ajouté dans cette étape. Aucun package installé. Données, plans et preuves dans sortir/recovery-data/2026-10-30-repair/, exclus de Git. État complet git-status.txt ; aucun commit/push.

**SCHEDULER CORRIGÉ ET TESTÉ : NON**

**PILOTE DATATOURISME 75 PRÊT POUR AUTORISATION : OUI**
