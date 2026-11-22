## Préparation locale du renouvellement — 22 novembre 2026

Le rôle et le compte existants ont été validés séparément. Le renouvellement à la demande est maintenant implémenté localement ; aucune configuration Render n’a été appliquée. Le reste de ce document conserve la préparation historique et ses anciens points de blocage, qui ne décrivent plus tous l’état actuel. Voir `jwt-renewal-preparation-2026-11-22.txt` pour la livraison locale.

Pour le futur raccordement, conserver `BOT_SAFE_START=on`, `BOT_AUTO_PIPELINES=off` et Auto-Deploy désactivé. Utiliser uniquement les variables dédiées suivantes sur le nouveau service :

- `SORTIR_MONITOR_SUPABASE_URL` : origine HTTPS du projet.
- `SORTIR_MONITOR_PUBLISHABLE_KEY` : clé publique dédiée au transport.
- `SORTIR_MONITOR_AUTH_EMAIL` : adresse du compte technique existant.
- `SORTIR_MONITOR_AUTH_USER_ID` : UUID exact de ce compte, vérifié dans chaque JWT.
- `SORTIR_MONITOR_AUTH_PASSWORD` : mot de passe existant, à fournir uniquement via les variables d’environnement du service dans Render. Ne pas mettre la valeur dans ce document, un fichier versionné, une commande shell ou un groupe partagé avec d’autres services.

Ne pas configurer `SORTIR_MONITOR_ACCESS_TOKEN` pour ce mode : cette variable conserve la compatibilité avec l’ancien mode de JWT fixe et prend priorité si elle est renseignée. Un JWT fixe invalide échoue sans repli vers Auth.

Le fournisseur ne lit aucun identifiant métier. Le transport PostgREST ne reçoit que la clé publique et le JWT éphémère. Le mot de passe reste dans la configuration privée du fournisseur ; un autre module du même processus n’est pas une isolation contre une compromission complète de Node.

Aucun appel Auth à l’import, à la construction du client ou à `/ping`. La première lecture autorisée récupère les clés publiques JWKS, authentifie le compte, clôture immédiatement sa session, vérifie signature ES256/identité/rôle/expiration et exige que GET Auth user soit refusé avec `session_not_found`. Le JWT est ensuite gardé en mémoire uniquement. Renouvellement à la demande lorsque moins de cinq minutes restent, avec une seule promesse partagée par processus. Aucun timer, cron, fichier de jeton ou refresh token réutilisé. Chaque appel HTTP est borné à dix secondes et interdit les redirections.

Les erreurs transitoires vident le cache et imposent trente secondes avant une nouvelle tentative déclenchée par une lecture. Les 401/403 PostgREST invalident le cache, sans retry automatique. Un ancien JWT encore valide ne sert pas de secours après un renouvellement échoué. Une réponse de connexion perdue, une clôture incertaine ou un refus Auth incohérent bloque le fournisseur jusqu’à son remplacement après diagnostic. Une session peut subsister côté Auth si le réseau empêche la déconnexion : le bot ne prétend pas l’avoir révoquée et n’utilise aucun JWT dans ce cas.

Gestion des secrets Render : https://render.com/docs/configure-environment-variables et https://render.com/articles/how-render-handles-secrets-and-environment-variables . Une future saisie autorisée doit rester limitée au nouveau service. L’option « Save only » n’applique les nouvelles variables qu’au prochain déploiement ; aucune de ces opérations n’est réalisée ici. Le compte technique et son mot de passe restent inchangés, le Trousseau local n’a pas été consulté pour cette livraison.

---

# Supervision SORTIR en lecture seule

Le client `monitor-read-client.js` est distinct du client métier. Il ne lit ni `SUPABASE_URL` ni `SUPABASE_SECRET_KEY`. Sans configuration dédiée valide, la route de supervision authentifiée renvoie 503 ; elle ne crée pas de client privilégié de secours. `/ping` reste disponible et expose seulement `supervisionConfigured`.

## Configuration future non appliquée

- `SORTIR_MONITOR_SUPABASE_URL` : origine HTTPS du projet, sans identifiants, port, chemin, query ou fragment.
- `SORTIR_MONITOR_PUBLISHABLE_KEY` : clé publique `sb_publishable_…`, jamais une clé secret/service_role.
- `SORTIR_MONITOR_ACCESS_TOKEN` : JWT signé par une autorité acceptée par le projet, avec `role=sortir_monitor_reader`, `iss=<origine>/auth/v1` et une expiration future. Recommander une durée courte pour les premiers contrôles ; aucune émission ou actualisation automatique n’est implémentée. Son expiration entraîne un échec fermé.

Le décodage local des claims ne vérifie pas la signature : cette vérification est effectuée par Supabase. La clé de signature doit rester hors du bot et hors de Render. Aucun secret ne doit être affiché dans les commandes, journaux, rapports ou Git. Aucun de ces paramètres n’est configuré sur Render par cette livraison.

## Droits proposés

`sortir/prepare-monitor-reader-2026-11-20.sql` est une préparation nécessitant une autorisation distincte d’intervention Supabase. Il finit par ROLLBACK et n’est jamais exécuté par npm, le build ou le démarrage.

Le rôle neuf `sortir_monitor_reader` est NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS, sans droit de création ou réplication. Seul le rôle technique PostgREST `authenticator` reçoit la possibilité de l’utiliser ; pas anon, authenticated ou service_role.

| Table | Colonnes SELECT |
|---|---|
| public.sortir_ingestion_runs | id, status, orchestrator_version, started_at, finished_at, error_summary |
| public.sortir_source_runs | id, started_at, status |

Deux politiques RLS exclusivement SELECT donnent accès aux lignes de ces tables. Aucun INSERT, UPDATE, DELETE, séquence, Storage, activité, provenance ou journal historique n’est accordé. Le script refuse des droits inattendus hérités de PUBLIC : autres tables, écritures même accordées par colonne, création de schémas, séquences et fonctions SECURITY DEFINER accessibles (hors fonctions trigger non invocables directement).

La création réelle requiert CREATE ROLE, GRANT et CREATE POLICY. **Cette étape est bloquée jusqu’à autorisation explicite**, en raison de l’interdiction actuelle d’écriture Supabase. Une future copie revue pourra remplacer le ROLLBACK final par COMMIT ; conserver le fichier original. Ne pas délivrer le JWT tant que les ACL réelles n’ont pas été relues sous exclusion de changements concurrents. L’émission du jeton et son installation sur Render sont des opérations distinctes.

## Défense du client

L’interface ne présente que `from(...).select(...)` et les filtres nécessaires sur deux tables et colonnes autorisées. Le transport refuse tout autre endpoint, projet, schéma ou méthode que GET/HEAD ; RPC, Auth, Storage, écritures et redirections sont bloqués avant réseau. Les lectures ont une limite temporelle de dix secondes, conservent le signal d’annulation et ne rafraîchissent aucune session Auth. Le rôle de base de données constitue la frontière d’autorisation, ces gardes client une protection supplémentaire.

Sous `BOT_SAFE_START=on`, la garde Storage empêche aussi son initialisation et sa restauration même si des clés métier étaient présentes. `BOT_AUTO_PIPELINES=off` est conservé. Ne pas fournir de clé métier pour contourner une erreur de configuration de supervision.

## Contrôles ultérieurs sous autorisation

1. Appliquer le seul provisionnement revu puis relire les rôles, memberships, droits par colonne et politiques ; aucune donnée métier modifiée.
2. Émettre un jeton de rôle dédié sans exposer la clé de signature, puis autoriser séparément son installation.
3. Maintenir les deux gardes et Auto-Deploy Off ; vérifier SHA et logs.
4. Vérifier GET /ping puis GET /api/sortir-ingest-status?current=1 authentifié. Préférer l’authentification cookie autorisée à un secret dans l’URL.
5. Comparer les preuves historiques ; aucun POST tick, aucune ingestion ni tentative d’écriture de test en production.

Les tests locaux utilisent des JWT synthétiques, des requêtes HTTP factices et PostgreSQL PGlite. Ils ne certifient pas encore la signature, le routage PostgREST ni les permissions d’une identité réelle dans Supabase. Aucun rôle, compte ou jeton réel n’a été créé.
