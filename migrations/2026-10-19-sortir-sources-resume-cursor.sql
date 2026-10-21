-- Ajoute un état mutable minimal permettant au scheduler DATAtourisme de reprendre la
-- pagination là où le cycle précédent s'est arrêté, au lieu de toujours redémarrer à la
-- première page (voir l'audit du 19/10/2026 : aucune colonne existante ne convenait, les
-- tables sortir_ingestion_runs/sortir_source_runs sont des journaux append-only, jamais relus
-- pour retrouver "le dernier état").
--
-- resume_cursor contient l'URL de reprise (meta.next, déjà nettoyée de toute clé API avant
-- d'être écrite par le code applicatif -- jamais la responsabilité de cette migration) ou NULL
-- quand il n'y a rien à reprendre (jamais exécuté, ou catalogue entièrement parcouru).
-- Portée strictement additive : aucune donnée existante touchée, aucune autre colonne/contrainte
-- modifiée.

begin;

alter table public.sortir_sources
  add column if not exists resume_cursor text;

commit;
