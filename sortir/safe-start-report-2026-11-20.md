# Démarrage sécurisé du bot — préparation locale du 20 novembre 2026

Aucun commit, push, déploiement, changement Render, accès Supabase réel, appel IA,
ingestion, publication ou réconciliation effectué pendant cette mission.
Le correctif quotidien précédent et les modifications étrangères sont préservés.

## Mécanismes audités

| Entrée | Traitements possibles avant correction |
|---|---|
| start.js | Lance server.js et veille-mixte.js ; recycle le worker sur sortie 75. Pas de job métier propre. |
| server.js à l'écoute HTTP | Programme RSS/Certamen ; reprend une collecte interrompue après 30 s. |
| YouTube | Première collecte immédiate puis horaire ; écrit curseurs/quota, sauvegarde Storage, peut publier vers Mnoria. |
| Files d'idées | Reprend les idées veille/Certamen ; délais, retries, file partagée ; IA et publications possibles. |
| Worker veille-mixte.js | Reprend les créativités Certamen pending sans consulter BOT_AUTO_PIPELINES ; IA et fichiers métier locaux. |
| Storage | Restauration initiale en lecture distante, puis uploads périodiques toutes les 30 min et uploads indirects. |
| HTTP externe/local | Les ticks GitHub et les routes manuelles peuvent lancer collectes, SORTIR, IA, publications et modifications. |

Les modules importés ont aussi été examinés et exécutés dans le banc isolé : leurs files
ne démarrent aucun job à l'import. Les timers présents dans les chaînes HTML destinées au
navigateur ne sont pas des timers Node ; leurs requêtes mutantes sont bloquées en mode sûr.
BOT_AUTO_PIPELINES contrôle déjà une partie du serveur, avec priorité à on/off puis RENDER.
Il ne suffit pas à couvrir le worker et Storage. Les flags de collecte/publication stockés
en JSON ne constituent pas non plus une protection globale.

## Solution retenue

Une politique commune, chargée après dotenv dans chaque enfant : **BOT_SAFE_START=on**.
Elle prend priorité sur RENDER et BOT_AUTO_PIPELINES=on. Une valeur non vide non reconnue
active aussi la protection ; absent, off, false ou 0 préservent le fonctionnement précédent.
La valeur est figée au démarrage, pas modifiable à chaud.

- Aucun job automatique n'est enregistré : collecte immédiate, scheduler, reprise à 30 s,
  idées, créativités, retries et synchronisation périodique.
- Les uploads Storage sont bloqués aussi à leur entrée commune, même en appel indirect.
- Les méthodes HTTP mutantes sont refusées avant les handlers : HTTP 503, code BOT_SAFE_START.
- GET/HEAD/OPTIONS, la supervision et POST /mixte-login restent accessibles. Les routes ne
  sont pas supprimées. Les actions manuelles métier restent suspendues pendant ce mode.
- La restauration Storage conserve ses lectures et son cache local ; les écritures locales
  opérationnelles du launcher (logs/PID) restent possibles. Ce n'est pas un disque read-only.
- GET /ping expose safeStart:true et automaticPipelines:false pour vérifier le nouveau processus.
- Le flag est hérité au lancement des deux enfants et lors du recyclage du worker.

Sans activation, les politiques Render/on/off, les tâches normales et les routes manuelles
restent inchangées. Aucun bail, nouvelle dépendance ou ordonnanceur n'est ajouté.

## Fichiers de cette mission

- runtime-policy.js : politique commune, garde du démarrage et middleware HTTP.
- server.js : branchement de la politique, des gardes et du diagnostic /ping.
- veille-mixte.js : garde de reprise des créativités et des routes mutantes.
- storage-sync.js : garde des uploads et de la programmation périodique.
- test-safe-start.js et sortir/test-helpers/safe-start-runtime.js : tests et banc isolé.
- sortir/safe-start-report-2026-11-20.md : présent rapport.

## Validation locale

**131 tests réussis, zéro échec**, dont 12 nouveaux tests de démarrage et les 84 tests
ciblés du correctif SORTIR ; les autres concernent YouTube. Les tests de démarrage
exécutent les véritables sources du launcher, du serveur, du worker et des modules locaux
dans des VM avec fichiers, SDK, réseau, processus et horloges simulés. Aucun .env réel
n'est chargé, aucune vraie collecte/publication n'est effectuée.

Avec clés factices, configs actives et files pending : zéro appel métier, upload ou SQL
mutant ; zéro tâche métier programmée, même après 48 h simulées et après recyclage.
Les appels mutateurs HTTP sont tous refusés ; login, /ping et supervision SORTIR passent.
Des contrôles sans protection démontrent que les automatismes et routes normales restent
actifs dans le banc, pour éviter un test qui passerait uniquement parce qu'il ne démarre rien.

```sh
node --test test-safe-start.js test-youtube-api.js test-youtube-collection.js sortir/test-daily-run-lifecycle.js sortir/test-scheduler-daily-catchup.js sortir/test-scheduler-cycle-close.js sortir/test-scheduler-repair.js sortir/test-monitor-scheduler.js test-sortir-scheduler-reunion.js sortir/test-paris-scheduler.js
```

Les douze plans restent valides ; writer et fichiers scellés inchangés. CodeHash :
1b1feff8f66eb18f10176c9ce15b753a331672dfcc2a17fc647c429608452a74.
Aucun changement du correctif quotidien n'est nécessaire pour fonctionner sous cette garde.

## Procédure de déploiement futur — autorisation obligatoire

1. Obtenir une autorisation distincte couvrant le commit/push limité, le flag Render et
   le déploiement. Ne rien exécuter sur la base de ce rapport seul.
2. Réconcilier uniquement en lecture les preuves de production avant mise en ligne :
   run abandonné toujours running avec la même empreinte, 1 512 items/1 433 identités,
   mutex inchangé et absence de traitement en cours. Ne pas utiliser une commande de reprise.
3. Préparer la mise en ligne avec auto-deploy désactivé. Garantir aussi l'arrêt ou la mise
   au repos effective de l'ancienne instance bot sous autorisation : le nouveau flag ne
   neutralise pas un processus déjà actif. Ne pas arrêter le service public Mnoria.
4. Préparer un SHA contenant seulement les deux correctifs audités et leurs tests.
   Exclure medias.json, youtube-chaines.json et les preuves/plans historiques.
   Vérifier Build/Pre-deploy/Start : aucune ingestion, migration ou script de reprise ;
   démarrage normal du bot par npm start, aucun mode benchmark/expérience.
5. Enregistrer BOT_SAFE_START=on sur le seul bot, **sans déployer ni redémarrer l'ancien
   artefact** (Save only). Publier le SHA contrôlé sans auto-deploy, puis demander son
   déploiement explicite avec ce flag déjà enregistré. Si Render ne permet pas de préparer
   code et environnement sans lancer l'ancien artefact, arrêter et revoir la procédure.
   Ne pas utiliser Resume/Restart sur l'ancien SHA : il ignore le nouveau flag.
6. Contrôler le SHA réellement actif et les deux messages safe-start. GET /ping doit
   confirmer safeStart:true et automaticPipelines:false. Contrôler le site public et
   GET /api/sortir-ingest-status?current=1 authentifié, puis comparer les preuves du point 2.
   Ne pas appeler un tick POST, monitor-scheduler.js ou une ingestion, même pour tester le refus.
7. Conserver le mode sûr, les files pending, le run et le mutex tels quels. Ne pas libérer
   ni désactiver le flag après la vérification : cela exige une nouvelle autorisation.
   Un retour arrière ne doit pas redémarrer l'ancien code non protégé.

Les tests utilisent le launcher simulé : ne pas lancer npm start dans le dépôt Mac pour
une simple vérification, car le launcher réel gère les anciens PID et les ports 3000/3002.

## Limites résiduelles

Le mode protège les points d'entrée normaux du bot, pas un script métier lancé directement
hors de ces processus ni une ancienne instance déjà en cours. Les simulations ne remplacent
pas la vérification du vrai SHA et de l'environnement Render. Les téléchargements de cache
peuvent ralentir le boot ; certains écrans nécessitant un POST de régénération HTML seront
indisponibles pendant la protection, contrairement aux routes de santé et de supervision.
Les workflows GitHub peuvent signaler HTTP 503 : ce refus est volontaire. Aucune ressource
Render supplémentaire n'est nécessaire pour ce mécanisme.
