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
