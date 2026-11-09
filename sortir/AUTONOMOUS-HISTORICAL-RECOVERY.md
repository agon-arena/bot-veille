# Exécution historique autonome locale

Ce processus Node.js n'appelle ni Codex, ni OpenAI, ni un autre modèle IA.
Les seuls échanges applicatifs sont des requêtes PostgreSQL du rôle de reprise
dédié. Il ne lance aucune ingestion et ne contacte pas l'API DATAtourisme.
Le writer, les plans scellés et leur codeHash sont inchangés.

## Exécution du 5 novembre 2026

**État constaté : ARRÊT AVANT ACTIVATION, erreur 25P03 dans le précontrôle
READ ONLY. Aucun lot du plan 007 ni aucune promotion n'a été exécuté.
La tâche est arrêtée, avec une seule exécution et aucun redémarrage.**
Le rapport et la réconciliation sont conservés dans le répertoire ci-dessous.
Les mécanismes décrits ensuite n'ont pas été activés pour une reprise longue.

Répertoire : `sortir/recovery-data/2026-11-05-autonomous-Ebqrqr/`.
Tâche macOS : `fr.mnoria.recovery.autonomous.r1793853679924`.

La tâche est chargée dans launchd, avec `KeepAlive=false`, sans calendrier ni
déclencheur récurrent. Son plist reste dans recovery-data, pas dans le dossier
LaunchAgents de démarrage. Aucun redémarrage automatique après erreur, fermeture
de Codex, déconnexion ou redémarrage du Mac n'est configuré. Un marqueur
`started-once` interdit une seconde exécution du même dossier.

Un verrou local global exclut deux exécuteurs autonomes. Aucun verrou PostgreSQL
n'est supprimé automatiquement. Un verrou local abandonné ne doit être retiré
qu'après preuve de l'arrêt des processus et réconciliation en lecture seule.

Les précontrôles se déroulent sans écriture. Le fichier `ready.json` confirme
85 checkpoints, les 8 137 promotions actives, leurs identités sans doublon
d'occurrence et le prochain lot 007/1. Aucune promotion n'est possible tant que
`ARM.json`, portant le sceau exact de configuration, n'a pas été créé après QA.
Ce fichier est consommé une seule fois.

## Limites et contrôles

- Au maximum 100 nouveaux lots, 10 000 promotions et 100 entrées par lot.
- Au maximum 18 heures depuis le lancement, et jamais après le 5 novembre 2026
  à 21 h Réunion. L'échéance la plus proche prévaut.
- Une seule transaction métier à la fois ; contrôle intégral avant le lot suivant.
- RSS surveillée indépendamment toutes les 500 ms, arrêt à un dépassement observé
  de 1,5 Gio. Le tas Node est plafonné à 768 Mio. Une panne du moniteur arrête
  aussi le traitement. Le maximum OS et les maxima observés sont rapportés.
- `caffeinate` empêche la veille automatique pendant la vie du superviseur.
  Le Mac doit rester allumé, connecté à Internet, branché et capot ouvert.
  Une panne matérielle, une coupure réseau ou une fermeture de session macOS
  ne sont pas rendues impossibles par ce mécanisme.
- Comparaison des champs immuables, provenances et identifiants ; recherche des
  mêmes occurrences sur d'autres activités actives, avant et après promotion.
- Tous les checkpoints sont relus et comparés ; les contrôles métier originaux
  et les dix verrous transactionnels du writer restent autoritatifs.

Les erreurs réseau AVANT toute tentative de COMMIT peuvent utiliser les retries
bornés existants. Dès qu'un COMMIT a été envoyé ou confirmé, une erreur arrête
la reprise : aucun replay automatique ni passage au lot suivant. La
réconciliation suivante est exclusivement READ ONLY. `25P03`, divergence,
doublon, concurrence et contrôle non confirmé arrêtent également le processus.

Les contrôles utilisent désormais l'autocommit READ ONLY : aucun BEGIN n'est
maintenu entre deux lectures ou pendant un calcul local. Le journal est paginé
par cinq checkpoints. Les paramètres READ ONLY et les délais de 15 s sont
appliqués à la session dédiée puis restaurés ; une restauration impossible ferme
la connexion. Le mode transactionnel Supavisor (6543) est refusé ; le mode
session vérifié utilise 5432. Les délais du writer restent inchangés.

Ces lectures préliminaires ne constituent plus un snapshot global REPEATABLE
READ. Le writer conserve sa vérification autoritative dans sa transaction sous
verrou ; les empreintes, identités et checkpoints restent contrôlés. La perte
d'une connexion ou l'échec d'un contrôle n'autorise toujours aucun replay ambigu.

Un précontrôle complet sans activation ni promotion est disponible avec
`node sortir/autonomous-historical-recovery.js --check /chemin/config.json`.
Ce mode maintient la connexion PostgreSQL en READ ONLY et retourne avant toute
lecture du fichier ARM ou appel au writer. Utiliser un dossier/configuration de
validation neuf : le marqueur d'une ancienne exécution ne doit pas être effacé.

## Suivi sans Codex

- `heartbeat.json` : phase, lot courant, mémoire, dernier appel SQL.
- `watchdog-heartbeat.json` : processus, mesure RSS externe, maximum observé.
- `execution.jsonl` : événements, timings SQL lents, contrôles et erreurs.
- `state.json` : progression locale, preuve du dernier lot et éventuel COMMIT
  en attente de réconciliation. Le journal PostgreSQL reste la source de vérité.
- `report.md` et `report.json` : bilan actualisé après chaque lot et à l'arrêt.
- `stdout.log`, `stderr.log`, `watchdog.jsonl` : journaux indépendants de Codex.

Ces fichiers restent locaux et ignorés par Git. Aucun secret n'y est enregistré.

Arrêt manuel contrôlé :

```sh
launchctl kill SIGTERM gui/501/fr.mnoria.recovery.autonomous.r1793853679924
```

Le superviseur termine son worker, lance au plus une réconciliation READ ONLY,
puis s'arrête. Il ne relance jamais un worker de promotion.

Après une interruption, consulter le rapport et réconcilier avant toute reprise.
Une nouvelle autorisation/configuration est nécessaire ; ne pas effacer le
marqueur pour relancer aveuglément. Les plans et le journal permettent de
reprendre au premier checkpoint absent avec les mécanismes existants.

## Autorisation de poursuivre tout le reliquat

Une configuration `continueToEnd` peut couvrir exactement le reliquat des plans
scellés. Elle doit inclure les empreintes de tous les checkpoints déjà validés
(`initialAnchors`), les comptes correspondants et le prochain lot attendu.
Ces ancrages sont vérifiés localement contre les plans puis contre PostgreSQL.
Le périmètre cumulé est borné au nombre exact d'entrées et de lots restants.

Les plafonds de 100 lots / 10 000 promotions restent inchangés **par tranche**.
Une tranche suivante ne peut commencer que si chaque lot de la précédente est
confirmé, sans doublon ni erreur, et sans COMMIT en attente. Il s'agit du même
processus séquentiel : aucun redémarrage, aucun second writer. Le mode habituel
sans cette autorisation garde son plafond global et ne poursuit pas implicitement.
L'échéance initiale, les 18 heures maximum et tous les plafonds mémoire restent
inchangés ; une nouvelle tranche ne remet aucune horloge à zéro.

Chaque résultat de lot conserve durée, temps writer, pic RSS observé sur ses
requêtes, empreinte du checkpoint et résultat d'intégrité. Le pic RSS OS du
processus est conservé séparément dans le rapport global. Un arrêt, une erreur
ou un dépassement interdit toute poursuite et entraîne au plus une réconciliation
READ ONLY, jamais une réparation ou un replay automatique.
