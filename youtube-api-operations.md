# YouTube → Autres actus

## Activation

Déployer ce code sur le service Render avec `YOUTUBE_API_KEY`. Aucun nouveau paquet
ni OAuth requis. Le worker démarre après la restauration Supabase, uniquement sur
l'instance qui a les pipelines automatiques actifs (`RENDER` ou
`BOT_AUTO_PIPELINES=on`, sauf `BOT_AUTO_PIPELINES=off`). Retirer la clé rétablit le
chemin RSS existant. La collecte Certamen n'est pas modifiée.

## Comportement

- Sources : `youtube-chaines.json`, chaînes et playlists ; doublons par ID vidéo.
- Au démarrage, puis chaque heure : collecte indépendante de l'IA et du calendrier
  des sessions presse. Le tick externe existant peut aussi réveiller une collecte
  échue, même si le calendrier éditorial est désactivé.
- Première lecture : lecture des vidéos publiées dans les 24 dernières heures.
- Ensuite : fenêtre glissante de 24 h, même après une interruption. Aucun
  rattrapage historique au-delà de 24 h ; la vérification quotidienne respecte cette fenêtre.
- Les playlists éditoriales peuvent être réordonnées : lecture de leur première
  page chaque heure et parcours complet quotidien, sans arrêt sur une date ancienne.
- Pages de 50 éléments ; 25 pages au maximum par source et cycle. Les longs
  rattrapages reprennent au curseur sauvegardé, sans être marqués comme terminés.
- Réessais sur les erreurs réseau, HTTP 429 et 5xx. Quota épuisé : arrêt du cycle,
  sans perte des vidéos déjà lues. Budget préventif de 8 000 requêtes par jour
  Pacific, partagé et persistant (le projet Google peut servir d'autres usages).
- Toutes les vidéos accessibles dans la période sont conservées sans filtre de
  titre pour l'envoi direct à Autres actus. Les vidéos privées/supprimées ne sont
  pas récupérables ; une vidéo passée publique très tard peut nécessiter une
  reprise historique plus profonde que les 24 h autorisées (elle ne sera donc pas importée automatiquement).

## Mémoire et envoi

`youtube-api-state.json` est écrit atomiquement après chaque page par `server.js`
uniquement. Le processus éditorial lit ce fichier pour ses sujets (fenêtre de 24
heures), mais l'envoi direct vers Autres actus utilise la file persistante.

Les vidéos non confirmées restent en attente sans expiration. L'envoi existant
par lots garde les mêmes `sessionKey` que les sessions mixtes : Agôn renouvelle
Autres actus lors d'un changement de session. Les vidéos confirmées des dernières 24
heures sont donc renvoyées dans la nouvelle session ; leurs identités sont gardées
au-delà, sans descriptions volumineuses. Les contenus associés à un débat déjà
publié restent exclus. Une session mixte existante est nécessaire à l'envoi.

Une réponse HTTP réussie d'Agôn confirme le lot ; erreur ou timeout laisse le lot
à reprendre. Les publications concurrentes sont sérialisées. La protection contre
le cas « Agôn a accepté mais la réponse a été perdue » dépend aussi de la
déduplication des liens côté Agôn ; le code de ce serveur n'est pas dans ce dépôt.

Le fichier de mémoire est inclus dans la synchronisation Supabase : sauvegarde
avant/après le cycle d'envoi, et périodiquement. Un échec de restauration distant
bloque l'utilisation/écrasement de ce fichier. Consulter les erreurs Supabase :
sur un disque Render éphémère, la durabilité entre redéploiements dépend d'une
synchronisation réussie. Après résolution d'un échec de restauration, redémarrer
le service pour restaurer proprement. Une mémoire JSON corrompue n'est jamais
réinitialisée silencieusement.

## Diagnostic

Les routes utilisent la même authentification que les routes de veille existantes :

- `GET /api/youtube-status` : dernière collecte, total, attente, compteur de quota,
  dernier succès/erreur et pagination en cours par source, rapport du dernier cycle.
- `POST /api/youtube/run` : lancement manuel, sans analyse IA. Réponse immédiate ;
  consulter le statut et les logs pour connaître l'issue.
- Logs Render : préfixe `[youtube-api]`, puis `[opinion-articles]` pour les envois.

La clé est transmise à Google dans un en-tête et n'est pas journalisée.

## Validation locale

`node --test test-youtube-api.js test-youtube-collection.js`

Tests avec réponses simulées : pagination, listes réordonnées, reprise de curseur,
respect des 24 h après interruption, quota, conservation, envoi réel du helper vers une fausse
réponse Agôn, échec/reprise, changement de session, exclusion des débats et
concurrence. Une validation réelle sur Render est nécessaire après déploiement :
la clé est configurée là-bas, pas dans cet environnement de test.

Références officielles :
- https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/list
- https://developers.google.com/youtube/data/reference/rest/v3/channels/list
- https://docs.cloud.google.com/docs/authentication/api-keys-use
