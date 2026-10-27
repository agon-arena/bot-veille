# Reprise manuelle verrouillée d'un checkpoint batch failed

Aucune reprise automatique. Aucun changement du RPC de reprise existant. Primitive installée
le 23 octobre 2026 via migrations/2026-10-23-sortir-datatourisme-reopen-failed-batch-scan.sql,
après sept contrôles PostgreSQL sur objets temporaires avec rollback et quatre tests statiques.
Droits vérifiés : SECURITY INVOKER, search_path=public, service_role seulement.

## État après la validation contrôlée du 23 octobre

Le pending initial a été rejoué au now original et acquitté normalement : 995 UNCHANGED,
5 invalides, 1 322 occurrences couvertes, aucune mutation des tables métier. La reprise a
ensuite reçu les pages 11–20 et s'est arrêtée sur un conflit REVIEW inter-POI à signature
identique (« Singulières »), avant l'acquittement du deuxième lot.

Le checkpoint est de nouveau failed, mais **pages=10 / received=1000**, avec le lot des pages
11–20 en pending. Ne pas réutiliser les assertions pages=0 / 995 UNCHANGED ci-dessous pour ce
nouveau pending. Il contient des écritures métier partielles et nécessite un nouveau dry-run
après revue du conflit, de l'activité review sans provenance laissée par l'arrêt et de la
politique d'horloge pour les pages nouvelles. Le runner actuel conserve started_at comme now
sur toute la reprise : trois occurrences du 22 octobre ont ainsi été réintroduites sur Drugeot/
COREFF après leur réparation au référentiel du 23 octobre. Aucun nettoyage automatique réalisé.
Le cas Lever du soleil est strictement inchangé.

Les sections suivantes documentent la procédure employée pour le **premier pending** ; elles
ne constituent pas une autorisation de poursuivre le deuxième lot.

## Conditions avant réouverture

1. Aucun autre writer DATAtourisme pendant l'opération ; aucun run running.
2. Précontrôle global en lecture seule :
   `node sortir/run-datatourisme-preflight.js` doit sortir avec code 0 (`ready=true`).
   Code 2 = incohérence détectée, code 1 = contrôle impossible ; tous deux bloquent la reprise.
   Exception manuelle expressément autorisée le 23 octobre : le contrôle peut rester ready=false
   UNIQUEMENT pour occurrence_interval_mismatch / provenance ee275edc-bcd2-45b0-ae65-d76e25720214 /
   POI 022b9d2d-73ca-33f7-942c-e99364a8b19f (Lever du soleil sur le Causse Méjean), si ses
   activités, provenances, external IDs et état POI sont strictement identiques au snapshot
   historique. Cela n'en fait pas un état sain. Le module global n'accepte aucune allowlist.
   Le pilote manuel vérifie cette exception intégralement et bloque toute mutation de ses données,
   toute autre issue et toute nouvelle réception de ce POI pendant ce scan pour revue humaine.
3. Snapshot complet du checkpoint, états POI, activités/provenances/IDs et SHA-256 des dix pages
   brutes archivées. Garder l'ancien snapshot même après la reprise.
4. Vérifier source et scan_id exacts, statut failed, batch_size=1000, pages=0, received=0,
   pending.count=1000, pending.page_count=10, pending.total=62940. Vérifier les 1 000 IDs uniques,
   l'ordre des dix pages, leurs URL/meta.next, le total et l'URL suivante contre pending.
5. Recalculer le lot archivé avec le now ORIGINAL `2026-10-22T17:53:41.312Z` et le code courant.
   Dry-run réalisé : 995 UNCHANGED, 5 invalides, 0 NEW/CHANGED, 0 entrée en persistance.
   Contrôler de nouveau la couverture réelle des 1 322 occurrences et les 212 empreintes déjà
   validées. Si la classification ou la couverture diffère : arrêt avant réouverture.

## Primitive minimale installée

Une RPC de réouverture explicite, service_role uniquement, prend `(source_id, scan_id,
p_expected_checkpoint jsonb)`. Le JSON attendu passe dans un corps POST, jamais un filtre GET.
Elle ouvre une transaction, verrouille la ligne source FOR UPDATE, vérifie le JSON COMPLET
contre le snapshot attendu (compare-and-swap), vérifie les invariants du lot, puis remplace
UNIQUEMENT `status: failed` par `status: running`. Aucun compteur, URL, pending, started_at,
last_finalized_id, état POI ou donnée métier n'est modifié.

Corps de la primitive (la migration inclut aussi BEGIN/COMMIT et le rechargement de schéma) :

```sql
create function public.sortir_dt_reopen_failed_batch_scan(
  p_source_id uuid, p_scan_id uuid, p_expected_checkpoint jsonb
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare v jsonb; pending jsonb; n integer; pages integer; received integer; total integer;
begin
  select datatourisme_national_scan into v from public.sortir_sources
    where id = p_source_id and key = 'datatourisme-national'
      and connector_type = 'datatourisme' for update;
  if not found or p_scan_id is null or p_expected_checkpoint is null
     or jsonb_typeof(p_expected_checkpoint) is distinct from 'object' then
    raise exception 'Source/snapshot invalide';
  end if;
  -- Retry après réponse perdue : idempotent seulement si rien n'a avancé depuis.
  if v = (p_expected_checkpoint || jsonb_build_object('status', 'running'))
     and p_expected_checkpoint->>'status' = 'failed'
     and v->>'id' = p_scan_id::text then return v; end if;
  if v is distinct from p_expected_checkpoint or v->>'id' is distinct from p_scan_id::text
     or v->>'status' is distinct from 'failed'
     or v->>'last_finalized_id' = p_scan_id::text
     or coalesce((v->>'batch_size')::integer, 0) not in (500,1000)
     or v->>'started_at' is null or v->>'initial_url' is null then
    raise exception 'Checkpoint modifié/non réouvrable';
  end if;
  pending := v->'pending';
  if jsonb_typeof(pending) is distinct from 'object'
     or jsonb_typeof(pending->'ids') is distinct from 'array'
     or pending->>'url' is null
     or pending->>'url' is distinct from v->>'next_url' then
    raise exception 'Lot pending incohérent';
  end if;
  n := (pending->>'count')::integer; pages := (pending->>'page_count')::integer;
  received := (v->>'received')::integer; total := (pending->>'total')::integer;
  if n is null or n <= 0 or pages is null or pages < 1
     or pages > (v->>'batch_size')::integer / 100
     or n > least((v->>'batch_size')::integer, pages * 100)
     or received is null or received < 0 or total is null or total <= 0
     or jsonb_array_length(pending->'ids') <> n
     or (select count(distinct value::uuid) from jsonb_array_elements_text(pending->'ids')) <> n
     or received + n > total
     or (v->>'total' is not null and (v->>'total')::integer <> total)
     or (pending->>'next' is null and received + n <> total)
     or (pending->>'next' is not null and received + n >= total) then
    raise exception 'Pagination pending incohérente';
  end if;
  v := v || jsonb_build_object('status', 'running');
  update public.sortir_sources set datatourisme_national_scan = v where id = p_source_id;
  return v;
end;
$$;
revoke all on function public.sortir_dt_reopen_failed_batch_scan(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.sortir_dt_reopen_failed_batch_scan(uuid, uuid, jsonb)
  to service_role;
```

Cette fonction ne suffit pas à autoriser une reprise : les contrôles applicatifs ci-dessus,
notamment la couverture et le précontrôle global, restent obligatoires. La transaction d'installation
DDL englobe fonction + revoke/grant ; ne pas réinstaller la migration pour rejouer le pending.

## Rejeu par le chemin existant

Après autorisation explicite et validation des préconditions : appeler la nouvelle RPC une seule fois, puis
`runNationalScanBatched({ resume: true, scanId: ORIGINAL, ... })`.

Pour le pending, fournir les dix pages brutes archivées inchangées via le callback fetchPage,
en vérifiant l'URL demandée et l'empreinte de chaque fichier. Ce sont les vraies pages reçues,
pas des réponses synthétiques. Garder leurs meta.next/total et le now original. Ne pas refetcher
silencieusement un lot qui aurait changé depuis : observeBatch refuse justement une liste d'IDs,
un ordre ou une pagination différents du pending déjà durable.

observeBatch rejoue son cas pending identique : aucune observation/empreinte n'est réinitialisée.
Le processeur recalcule les 1 000 POI ; un garde explicite refuse toute entrée en persistance
sur ce pending (995 UNCHANGED attendus). Les cinq invalides restent observés, sans remplacement
vide ni désactivation. Revalider la couverture, puis laisser finishBatch acquitter le lot :
10 pages, 1 000 reçus, 5 invalides, prochain URL = pending.next. Ne JAMAIS appeler finishBatch
directement pour sauter le traitement au seul motif que 212 empreintes ont déjà été validées.

Ensuite seulement, passer le callback fetchPage au transport DATAtourisme réel pour la page 11,
avec le filtre initial, même now, total stable, vérification des doublons inter-pages et protections
existantes. Tout changement de total, curseur invalide, changement du pending ou incohérence
bloque la reprise : aucune réinitialisation de filtre/now et aucune finalisation forcée.

Ne vider pending et ne remettre pages/received à zéro à aucun moment. Ne supprimer/réinitialiser
aucune des 212 empreintes. Ne rejouer ni les 379 occurrences ni leurs collection items. La finalisation
nationale reste réservée à la réception/au traitement réussi de toutes les pages.

## Correctif après audit page 13 — reprise toujours interdite

L'activité résiduelle 4588b8a1-d113-4c30-b1b5-89b313001b36 a été mise en stale uniquement,
après preuve d'absence de toutes relations et comparaison intégrale avec le snapshot interrompu.
Aucune provenance supprimée, aucune empreinte modifiée, aucun checkpoint repris.

Le pipeline expose désormais `beforeCreateActivity` (également transmis par
`createDatatourismePoiPersister`). Le pilote contrôlé doit y installer
`guardExactSignatureReview` de datatourisme-activity-safety.js, et arrêter sur un résultat de
persistance non completed. Ne JAMAIS réinstaller le refus de doublon dans le traitement de
la réponse HTTP d'un INSERT : il survient trop tard. Le transport ne fait que mesurer.
Les créations REVIEW comme DISTINCT commencent en stale ; active/review seulement après
provenance et external IDs réussis. Un INSERT dont la réponse est perdue peut laisser du staging
stale, mais aucune activité fonctionnelle sans provenance. Aucun MATCH forcé par signature.

### Horloges distinctes

* started_at/initial_url : périmètre du catalogue et horloge d'observation, immuables.
* pending.selection_now : référentiel de sélection propre au lot, durable et immuable au rejeu.
* now fourni à la reprise : référentiel pour les NOUVEAUX lots après acquittement du pending.

Un pending ancien sans selection_now utilise started_at UNIQUEMENT pour ce pending.
Les pages neuves n'héritent jamais de cet ancien référentiel. La migration proposée
`2026-10-23-sortir-datatourisme-batch-selection-clock.sql` ajoute une RPC v2 qui verrouille
la source, délègue les contrôles existants et enregistre selection_now dans la même transaction.
Elle n'est PAS appliquée. Le nouvel adaptateur appelle cette v2 : avant installation/validation
SQL explicites, il doit échouer, sans fallback silencieux vers la mauvaise horloge.

### Rebase exceptionnel des pages 11–20 (PROPOSITION NON EXÉCUTÉE)

Ce pending est historiquement erroné : lui appliquer automatiquement le fallback started_at
réintroduirait le bug. Après arbitrage Singulières et nouveau dry-run au référentiel retenu :

1. Suspendre tout autre writer, refaire snapshot et précontrôle, contrôler intégralement les
   dix archives (hash, UUID ordonnés, URL et meta.next) contre pending. Attendre exactement
   scan 384c3c2f-649f-482f-a3dd-9431e6e163fc, failed, pages=10, received=1000, pending.count=1000,
   page_count=10, total=62940. Aucune mutation si la comparaison JSON intégrale échoue.
2. Installer/valider séparément la RPC v2 avec autorisation. Préparer une transaction explicite
   de rebase FOR UPDATE + comparaison du JSON COMPLET attendu : ajouter uniquement
   pending.selection_now=T (T courant approuvé), conserver failed et tous les compteurs/curseurs.
   Cette opération est exceptionnelle, pas un paramètre libre de reprise générique.
3. Dans cette même transaction, vérifier les anciennes empreintes/versions et marquer
   needs_reprocess=true UNIQUEMENT sur Drugeot 045ac97d-0b28-3346-9639-f8410e6c6f47 et
   COREFF 04c13033-efaf-311e-ac3c-3aadd5b35182. Ne pas effacer leurs références. Sans cette
   invalidation, une empreinte déjà correcte pourrait masquer les trois soutiens réintroduits
   après sa validation. Vérifier ces trois provenances exactes contre le snapshot.
4. Refaire dry-run depuis cet état projeté ; la présence d'une observation ou de
   last_observed_scan_id ne vaut jamais validation. Les références nulles restent NEW, les
   conversions invalides restent en retry et ne réconcilient rien.
5. Seulement après résultat sans blocage et accord de reprise : RPC de réouverture CAS avec
   le NOUVEAU JSON attendu, failed→running uniquement. Rejouer les dix archives à T via le
   pipeline normal. Les provenances/IDs existants sont réutilisés ; ne pas refaire les INSERT
   bruts ni supprimer l'historique. Les écritures valides partielles restent idempotentes.
6. Vérifier couverture/external IDs/intervalles et empreintes avant tout acquittement normal.
   Tant qu'un NEW/CHANGED n'est pas validé, finishBatch est interdit. Les pages 21+ utiliseront
   le now du run courant, enregistré avec chaque nouveau pending.

Le dry-run du 23 octobre à 14:26:31.139Z, intégralement en mémoire, produit 986 NEW,
4 CHANGED, 4 UNCHANGED, 6 invalides et 1380 occurrences sélectionnées. Il conserve les identités
des liens des 221 collection items déjà écrits et ne réactive aucune occurrence passée Drugeot/
COREFF. Il bloque 29 créations REVIEW Singulières : le lot de 100 contenant ce POI n'obtient
aucune validation d'empreinte (100 références non validées, 890 validables ailleurs dans la
simulation). Ce n'est PAS une reprise autorisée ou un plan à appliquer tel quel. Les sous-lots
suivants n'ont été simulés que pour l'inventaire hors ligne. En réel, le pilote doit s'arrêter au
premier blocage. Il reste à décider le traitement inter-UUID de cette exposition ; les 116 périodes
brutes identiques n'autorisent pas à inventer une règle générale de fusion.

Le précontrôle global inclut maintenant toutes les activités active/review et leurs soutiens de
TOUTES sources, ainsi que les groupes de signatures en conflit. Une lecture partielle ou un
store dépourvu de lecture des activités bloque le contrôle. Aucune allowlist de signatures.
