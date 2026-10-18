"use strict";

const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const { validateNormalizedActivity } = require("./activity-validation");
const { ALGORITHM_VERSION, DECISIONS, compareActivities, mergeActivities, canonicalUrl, normalizedText } = require("./activity-deduplication");
const { ORCHESTRATOR_VERSION } = require("./ingestion-orchestrator");

const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
// Borne la taille des .in(...) envoyés à PostgREST (disparitions groupées) : évite une URL
// démesurée si plusieurs milliers d'activités disparaissent dans un même run. La fréquence
// réelle des disparitions ne justifie pas d'ajuster cette valeur avant mesure en conditions réelles.
const DISAPPEARANCE_CHUNK_SIZE = 500;
// Même borne et même justification que DISAPPEARANCE_CHUNK_SIZE (taille raisonnable pour un
// .in(...) PostgREST), réutilisée pour le préchargement par lot des provenances/activités
// connues d'une source : jamais plusieurs milliers de clés dans une seule URL.
const PRELOAD_CHUNK_SIZE = 500;
let ingestionQueue = Promise.resolve();

function chunkIds(ids, size = DISAPPEARANCE_CHUNK_SIZE) {
  const chunks = [];
  for (let index = 0; index < ids.length; index += size) chunks.push(ids.slice(index, index + size));
  return chunks;
}
// Reflète exactement l'expression de l'index unique réel : UNIQUE (source_id,
// COALESCE(source_record_id,''), source_occurrence_key). Une Map indexée par
// source_occurrence_key seule confondrait deux provenances distinctes qui partageraient par
// accident la même clé d'occurrence avec des source_record_id différents — jamais observé chez
// les connecteurs réels (qui n'embarquent eux-mêmes jamais sourceOccurrenceKey, voir
// sourceMetadata), mais la Map doit rester correcte même si un connecteur futur ou un test le
// faisait.
function provenanceMapKey(sourceRecordId, sourceOccurrenceKey) {
  return `${sourceRecordId ?? ""}\u0000${sourceOccurrenceKey}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function payloadHash(value) { return crypto.createHash("sha256").update(stableJson(value ?? null)).digest("hex"); }
function errorText(error) { return String(error && (error.message || error) || "Erreur inconnue"); }
function sanitizeSourcePayload(value) {
  if (Array.isArray(value)) return value.map(sanitizeSourcePayload);
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(headers?|response|raw|html|body|content|description)$/i.test(key)) continue;
    result[key] = sanitizeSourcePayload(item);
  }
  return result;
}
function compactPayload(activity) {
  return { title: activity.title, startsAt: activity.startsAt, endsAt: activity.endsAt, lifecycleStatus: activity.lifecycleStatus, venueName: activity.venueName, city: activity.city, bookingUrl: activity.bookingUrl, admissionType: activity.admissionType };
}
// Trie un ensemble (pas une séquence : l'ordre d'arrivée n'a pas de sens métier) par une clé
// stable, pour que deux lots équivalents dans un ordre différent produisent le même hash.
function sortedByKey(items, keyFn) {
  return [...items].sort((a, b) => { const left = keyFn(a), right = keyFn(b); return left < right ? -1 : left > right ? 1 : 0; });
}
// Représentation canonique de l'état métier d'une NormalizedActivity : l'intégralité des champs
// que mergeActivities()/activityToRow()/upsertExternalIds() ou la déduplication peuvent lire ou
// écrire (dérivé du code réel, pas de la liste indicative d'activity-schema.js). Exclut
// délibérément `provenances` (métadonnées sur la façon dont l'activité a été trouvée, jamais
// écrites par activityToRow, suivies séparément via sortir_provenances) et
// `sourceCategories`/`sourceTags` (jamais persistées, réservées à la future taxonomie). Suppose
// que `activity` a déjà traversé normalizeActivity()/validateNormalizedActivity() — toujours le
// cas au seul point d'appel (sourceMetadata reçoit validation.activity) — donc les valeurs
// absentes sont déjà uniformément `null`/`[]`/`{}`, jamais `undefined`.
function canonicalActivityPayload(activity) {
  return {
    title: activity.title, description: activity.description, startsAt: activity.startsAt, endsAt: activity.endsAt,
    timezone: activity.timezone, lifecycleStatus: activity.lifecycleStatus, locationType: activity.locationType,
    venueName: activity.venueName, address: activity.address, postalCode: activity.postalCode, city: activity.city,
    country: activity.country, latitude: activity.latitude, longitude: activity.longitude, onlineUrl: activity.onlineUrl,
    // Ensemble de co-organisateurs : pas de séquence sémantique.
    organizers: sortedByKey(activity.organizers, (o) => `${normalizedText(o.name)}\u0000${canonicalUrl(o.url) || ""}`),
    category: activity.category, subcategory: activity.subcategory,
    // Ensemble de tags : pas de séquence sémantique.
    tags: sortedByKey(activity.tags, (tag) => String(tag).toLocaleLowerCase("fr-FR")),
    imageUrl: activity.imageUrl, bookingUrl: activity.bookingUrl, admissionType: activity.admissionType,
    // Ensemble d'identifiants externes : pas de séquence sémantique.
    externalIds: sortedByKey(activity.externalIds, (id) => `${id.system}\u0000${id.value}`),
    confidence: activity.confidence,
    // Dictionnaire champ → confiance : stableJson() trie déjà les clés, aucun tri supplémentaire ici.
    fieldConfidence: activity.fieldConfidence,
    // Ensemble de preuves rattachées à des champs : pas une séquence chronologique.
    evidence: sortedByKey(activity.evidence, (item) => `${item.field}\u0000${item.sourceValue || ""}\u0000${item.excerpt || ""}`)
  };
}
function sourceMetadata(item, source) {
  const activity = item.activity;
  const provenance = activity.provenances[0] || {};
  const sourceRecordId = item.sourceRecordId ?? provenance.externalId ?? null;
  return {
    sourceRecordId,
    sourceOccurrenceKey: item.sourceOccurrenceKey || `${sourceRecordId || canonicalUrl(provenance.originalEventUrl) || "sans-id"}@${activity.startsAt}`,
    originalEventUrl: canonicalUrl(provenance.originalEventUrl),
    // Rôle audit/traçabilité (colonne sortir_provenances.source_payload) : inchangé, distinct du
    // hash métier ci-dessous. Ne jamais faire reposer payloadHash() sur cette valeur : elle reste
    // volontairement partielle (compactPayload) quand le connecteur ne fournit pas sourcePayload.
    sourcePayload: sanitizeSourcePayload(item.sourcePayload || compactPayload(activity)),
    // Rôle hash métier (colonne sortir_provenances.payload_hash) : représentation canonique
    // complète, découplée du format brut des fournisseurs.
    canonicalActivityPayload: canonicalActivityPayload(activity),
    sourceKey: source.key
  };
}
function activityToRow(activity, recordStatus = "active") {
  return {
    title: activity.title, description: activity.description, starts_at: activity.startsAt, ends_at: activity.endsAt,
    timezone: activity.timezone, lifecycle_status: activity.lifecycleStatus, location_type: activity.locationType,
    venue_name: activity.venueName, address: activity.address, postal_code: activity.postalCode, city: activity.city,
    country: activity.country, latitude: activity.latitude, longitude: activity.longitude, online_url: activity.onlineUrl,
    booking_url: activity.bookingUrl, admission_type: activity.admissionType, organizers: activity.organizers,
    category: activity.category, subcategory: activity.subcategory, tags: activity.tags, image_url: activity.imageUrl,
    confidence: activity.confidence, field_confidence: activity.fieldConfidence, evidence: activity.evidence,
    record_status: recordStatus, last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString()
  };
}
function rowToActivity(row) {
  return {
    title: row.title, description: row.description, startsAt: row.starts_at, endsAt: row.ends_at, timezone: row.timezone,
    lifecycleStatus: row.lifecycle_status, locationType: row.location_type, venueName: row.venue_name, address: row.address,
    postalCode: row.postal_code, city: row.city, country: row.country, latitude: row.latitude, longitude: row.longitude,
    onlineUrl: row.online_url, bookingUrl: row.booking_url, admissionType: row.admission_type, organizers: row.organizers || [],
    category: row.category, subcategory: row.subcategory, tags: row.tags || [], imageUrl: row.image_url,
    confidence: row.confidence, fieldConfidence: row.field_confidence || {}, evidence: row.evidence || [],
    provenances: (row.provenances || []).map((p) => ({ sourceType: p.source && p.source.connector_type || "database", sourceName: p.source && p.source.key || p.source_id || "source-inconnue", sourceUrl: p.source && p.source.base_url || null, originalEventUrl: p.original_event_url, externalId: p.source_record_id, fetchedAt: p.last_seen_at })),
    externalIds: (row.external_ids || []).map((id) => ({ system: id.system, value: id.value }))
  };
}

async function persistSortirIngestionUnlocked({ sources, store, now = new Date(), staleAfterMs = DEFAULT_STALE_AFTER_MS }) {
  if (!store) throw new Error("store est obligatoire");
  const startedAt = now.toISOString();
  const ingestion = await store.createIngestionRun({ status: "running", orchestrator_version: ORCHESTRATOR_VERSION, started_at: startedAt });
  const totals = { collected: 0, VALID: 0, NEEDS_REVIEW: 0, INVALID: 0, merged: 0, toReview: 0, final: 0 };
  const sourceOutcomes = [];

  for (const descriptor of Array.isArray(sources) ? sources : []) {
    let source = null;
    let sourceRun = null;
    const counts = { collected: 0, VALID: 0, NEEDS_REVIEW: 0, INVALID: 0 };
    const errors = [];
    let sourceStatus = "completed";
    try {
    source = await store.ensureSource(descriptor);
    sourceRun = await store.createSourceRun({ ingestion_run_id: ingestion.id, source_id: source.id, status: "running", started_at: startedAt });
    if (descriptor.error) { sourceStatus = "failed"; errors.push(errorText(descriptor.error)); }
    else if (!Array.isArray(descriptor.results)) { sourceStatus = "failed"; errors.push("Résultats source absents ou invalides."); }
    else {
      // Préchargement par lot des LECTURES seules (findProvenance/getActivity), avant la boucle
      // qui écrit : un aller-retour "en trop" ici (validation déjà pure/sans effet de bord,
      // refaite ensuite dans la boucle principale) coûte zéro Supabase, et garde la boucle
      // principale strictement identique à son comportement actuel pour tout le reste
      // (listCandidateActivities/MATCH/REVIEW/DISTINCT/création : non touchés à cette étape).
      const preloadOccurrenceKeys = new Set();
      for (const connectorResult of descriptor.results) {
        try {
          const wrapped = connectorResult && typeof connectorResult === "object" && ("activity" in connectorResult || "error" in connectorResult);
          if (wrapped && connectorResult.error) continue;
          const activityInput = wrapped ? connectorResult.activity : connectorResult;
          const validation = validateNormalizedActivity(activityInput);
          if (validation.status === "INVALID") continue;
          const item = { ...(wrapped ? connectorResult : {}), activity: validation.activity };
          preloadOccurrenceKeys.add(sourceMetadata(item, source).sourceOccurrenceKey);
        } catch (_) { /* erreur de préparation : re-détectée et comptabilisée dans la boucle principale */ }
      }
      const preloadedProvenances = await store.findProvenancesBatch(source.id, [...preloadOccurrenceKeys]);
      const provenanceMap = new Map(preloadedProvenances.map((row) => [provenanceMapKey(row.source_record_id, row.source_occurrence_key), row]));
      const preloadActivityIds = [...new Set(preloadedProvenances.map((row) => row.activity_id))];
      const preloadedActivities = await store.getActivitiesBatch(preloadActivityIds);
      const activityMap = new Map(preloadedActivities.map((row) => [row.id, row]));

      for (let index = 0; index < (Array.isArray(descriptor.results) ? descriptor.results : []).length; index += 1) {
        const connectorResult = descriptor.results[index];
        counts.collected += 1; totals.collected += 1;
        let unlinkedActivityId = null;
        let validationStatus = null;
        try {
          const wrapped = connectorResult && typeof connectorResult === "object" && ("activity" in connectorResult || "error" in connectorResult);
          if (wrapped && connectorResult.error) throw new Error(errorText(connectorResult.error));
          const activityInput = wrapped ? connectorResult.activity : connectorResult;
          const validation = validateNormalizedActivity(activityInput);
          validationStatus = validation.status;
          counts[validation.status] += 1; totals[validation.status] += 1;
          if (validation.status === "INVALID") {
            await store.insertCollectionItem({ source_run_id: sourceRun.id, validation_status: "INVALID", diagnostics: { errors: validation.errors, warnings: validation.warnings, sourceIndex: index } });
            continue;
          }
          const item = { ...(wrapped ? connectorResult : {}), activity: validation.activity };
          const metadata = sourceMetadata(item, source);
          const hash = payloadHash(metadata.canonicalActivityPayload);
          // Lecture préchargée (Map), jamais un appel individuel : voir le préchargement en
          // tête de boucle. provenance.activity_id est garanti présent dans activityMap, puisque
          // preloadActivityIds est construit à partir exactement des mêmes provenances.
          let provenance = provenanceMap.get(provenanceMapKey(metadata.sourceRecordId, metadata.sourceOccurrenceKey)) || null;
          let activityId;
          if (provenance) {
            const existing = activityMap.get(provenance.activity_id);
            if (!existing) throw new Error("Activité préchargée introuvable (incohérence interne du préchargement par lot).");
            // existing.record_status n'est pas disponible sur la ligne provenance seule : savoir
            // si l'activité est stale (à réactiver) exige de lire l'activité — via la Map
            // préchargée, jamais via un nouvel appel individuel.
            if (provenance.payload_hash === hash) {
              // Fast-path : le hash canonique confirme qu'aucune donnée métier de CETTE source
              // n'a changé depuis la dernière observation. mergeActivities()/upsertExternalIds()
              // produiraient par construction le même résultat déjà stocké — jamais exécutés.
              // La provenance est quand même revue à chaque passage (last_seen_at/
              // last_seen_run_id/active, nécessaires à applyDisappearances), et l'activité est
              // réactivée si (et seulement si) elle était retombée stale — jamais de merge complet
              // pour ce seul changement de statut : record_status/updated_at suffisent.
              await store.updateProvenance(provenance.id, { last_seen_at: startedAt, active: true, last_seen_run_id: sourceRun.id });
              if (existing.record_status === "stale") {
                const updated = await store.updateActivity(existing.id, { record_status: "active", updated_at: startedAt });
                // Une activité fusionnée peut recevoir plusieurs provenances DANS le même lot :
                // si un item ultérieur du même lot pointe vers cette même activité, il doit voir
                // ce nouvel état (record_status), pas la photo prise au début du run. Les clés
                // provenances/external_ids de la photo restent volontairement inchangées : ni
                // activityToRow() ni upsertExternalIds() ne les lisent jamais sur CE chemin
                // (provenances/externalIds persistées séparément, jamais via ces colonnes), donc
                // leur péremption éventuelle ici est sans effet observable.
                activityMap.set(existing.id, { ...existing, ...updated });
              }
            } else {
              const merged = mergeActivities(rowToActivity(existing), validation.activity).activity;
              await store.updateProvenance(provenance.id, { last_seen_at: startedAt, active: true, last_seen_run_id: sourceRun.id, payload_hash: hash, source_payload: metadata.sourcePayload });
              await store.upsertExternalIds(existing.id, source.id, validation.activity.externalIds);
              const updated = await store.updateActivity(existing.id, activityToRow(merged, existing.record_status === "stale" ? "active" : existing.record_status));
              activityMap.set(existing.id, { ...existing, ...updated });
            }
            activityId = existing.id;
          } else {
            const candidates = await store.listCandidateActivities(validation.activity);
            const comparisons = candidates.map((candidate) => ({ candidate, result: compareActivities(rowToActivity(candidate), validation.activity) }));
            const match = validation.status === "VALID" ? comparisons.find((entry) => entry.result.decision === DECISIONS.MATCH) : null;
            const reviews = comparisons.filter((entry) => entry.result.decision === DECISIONS.REVIEW);
            let createdActivityId = null;
            let desiredRecordStatus = null;
            if (match) {
              const merged = mergeActivities(rowToActivity(match.candidate), validation.activity).activity;
              await store.updateActivity(match.candidate.id, activityToRow(merged, match.candidate.record_status));
              await store.insertDedupDecision({ ingestion_run_id: ingestion.id, left_activity_id: match.candidate.id, right_activity_id: match.candidate.id, decision: "MATCH", algorithm_version: ALGORITHM_VERSION, signals: match.result.signals, review_status: "not_required" });
              activityId = match.candidate.id; totals.merged += 1;
            } else {
              const underReview = validation.status === "NEEDS_REVIEW" || reviews.length > 0;
              desiredRecordStatus = underReview ? "review" : "active";
              const created = await store.createActivity(activityToRow(validation.activity, underReview ? "review" : "stale"));
              activityId = created.id; createdActivityId = created.id; unlinkedActivityId = created.id;
              if (underReview) { totals.toReview += 1; }
              for (const review of reviews) await store.insertDedupDecision({ ingestion_run_id: ingestion.id, left_activity_id: review.candidate.id, right_activity_id: created.id, decision: "REVIEW", algorithm_version: ALGORITHM_VERSION, signals: review.result.signals, review_status: "pending" });
            }
            provenance = await store.createProvenanceIdempotent({ activity_id: activityId, source_id: source.id, source_record_id: metadata.sourceRecordId, source_occurrence_key: metadata.sourceOccurrenceKey, original_event_url: metadata.originalEventUrl, source_payload: metadata.sourcePayload, payload_hash: hash, first_seen_at: startedAt, last_seen_at: startedAt, last_seen_run_id: sourceRun.id, active: true });
            unlinkedActivityId = null;
            if (provenance.activity_id !== activityId) {
              const raced = await store.getActivity(provenance.activity_id);
              const merged = mergeActivities(rowToActivity(raced), validation.activity).activity;
              await store.updateActivity(raced.id, activityToRow(merged, raced.record_status === "stale" ? "active" : raced.record_status));
              if (createdActivityId) await store.markActivityMerged(createdActivityId, raced.id);
              activityId = provenance.activity_id;
            }
            await store.upsertExternalIds(activityId, source.id, validation.activity.externalIds);
            if (createdActivityId && provenance.activity_id === createdActivityId && desiredRecordStatus === "active") {
              await store.updateActivity(createdActivityId, { record_status: "active", updated_at: startedAt });
            }
          }
          await store.insertCollectionItem({ source_run_id: sourceRun.id, provenance_id: provenance.id, activity_id: activityId, validation_status: validation.status, diagnostics: { errors: validation.errors, warnings: validation.warnings, sourceIndex: index } });
        } catch (error) {
          if (!validationStatus) { counts.INVALID += 1; totals.INVALID += 1; }
          errors.push(`élément ${index}: ${errorText(error)}`); sourceStatus = "partial";
          if (unlinkedActivityId) { try { await store.updateActivity(unlinkedActivityId, { record_status: "stale", updated_at: startedAt }); } catch (_) {} }
          try { await store.insertCollectionItem({ source_run_id: sourceRun.id, validation_status: validationStatus || "INVALID", diagnostics: { sourceIndex: index, persistenceError: errorText(error) } }); } catch (_) {}
        }
      }
    }
    if (sourceStatus === "completed") {
      try { await store.applyDisappearances({ sourceId: source.id, sourceRunId: sourceRun.id, cutoff: new Date(now.getTime() - staleAfterMs).toISOString() }); }
      catch (error) { sourceStatus = "partial"; errors.push(`disparitions: ${errorText(error)}`); }
    }
    await store.updateSourceRun(sourceRun.id, { status: sourceStatus, collected_count: counts.collected, valid_count: counts.VALID, needs_review_count: counts.NEEDS_REVIEW, invalid_count: counts.INVALID, error: errors.length ? errors.join("; ") : null, finished_at: startedAt });
    sourceOutcomes.push({ source: source.key, status: sourceStatus, counts, errors });
    } catch (error) {
      sourceStatus = "failed";
      errors.push(errorText(error));
      if (sourceRun) { try { await store.updateSourceRun(sourceRun.id, { status: "failed", collected_count: counts.collected, valid_count: counts.VALID, needs_review_count: counts.NEEDS_REVIEW, invalid_count: counts.INVALID, error: errors.join("; "), finished_at: startedAt }); } catch (_) {} }
      sourceOutcomes.push({ source: source && source.key || descriptor && descriptor.key || "source-inconnue", status: sourceStatus, counts, errors });
    }
  }
  const status = !sourceOutcomes.length || sourceOutcomes.every((item) => item.status === "failed") ? "failed"
    : sourceOutcomes.every((item) => item.status === "completed") ? "completed" : "partial";
  totals.final = await store.countFinalActivities();
  await store.updateIngestionRun(ingestion.id, { status, collected_count: totals.collected, valid_count: totals.VALID, needs_review_count: totals.NEEDS_REVIEW, invalid_count: totals.INVALID, merged_count: totals.merged, review_count: totals.toReview, final_count: totals.final, error_summary: sourceOutcomes.filter((item) => item.errors.length), finished_at: startedAt });
  return { ingestionRunId: ingestion.id, status, stats: totals, sources: sourceOutcomes };
}

function persistSortirIngestion(options) {
  const run = ingestionQueue.then(() => persistSortirIngestionUnlocked(options));
  ingestionQueue = run.catch(() => undefined);
  return run;
}

async function mergeStoredActivities({ store, canonicalId, duplicateId }) {
  if (!store) throw new Error("store est obligatoire");
  if (canonicalId === duplicateId) return store.getActivity(canonicalId);
  const canonical = await store.getActivity(canonicalId);
  const duplicate = await store.getActivity(duplicateId);
  if (duplicate.record_status === "merged" && duplicate.merged_into_id === canonicalId) return canonical;
  const merged = mergeActivities(rowToActivity(canonical), rowToActivity(duplicate)).activity;
  await store.updateActivity(canonicalId, activityToRow(merged, canonical.record_status === "stale" ? "active" : canonical.record_status));
  await store.moveProvenances(duplicateId, canonicalId);
  await store.moveExternalIds(duplicateId, canonicalId);
  await store.markActivityMerged(duplicateId, canonicalId);
  return store.getActivity(canonicalId);
}

function createSupabaseSortirStore(client) {
  if (!client) throw new Error("client Supabase obligatoire");
  const one = async (query) => { const { data, error } = await query; if (error) throw new Error(error.message); return data; };
  return {
    async ensureSource(source) { return one(client.from("sortir_sources").upsert({ key: source.key, connector_type: source.connectorType, base_url: source.baseUrl || null, enabled: true, updated_at: new Date().toISOString() }, { onConflict: "key" }).select().single()); },
    createIngestionRun: (row) => one(client.from("sortir_ingestion_runs").insert(row).select().single()),
    updateIngestionRun: (id, row) => one(client.from("sortir_ingestion_runs").update(row).eq("id", id).select().single()),
    createSourceRun: (row) => one(client.from("sortir_source_runs").insert(row).select().single()),
    updateSourceRun: (id, row) => one(client.from("sortir_source_runs").update(row).eq("id", id).select().single()),
    async findProvenance(sourceId, recordId, occurrenceKey) { let q = client.from("sortir_provenances").select("*").eq("source_id", sourceId).eq("source_occurrence_key", occurrenceKey); q = recordId == null ? q.is("source_record_id", null) : q.eq("source_record_id", recordId); const { data, error } = await q.maybeSingle(); if (error) throw new Error(error.message); return data; },
    // Lecture groupée, par chunks bornés : le filtre PostgREST ne porte que sur
    // source_occurrence_key (plus large que la contrainte réelle, qui inclut aussi
    // source_record_id) — l'appelant doit donc toujours affiner avec provenanceMapKey() sur le
    // résultat, jamais se fier à occurrence_key seule pour retrouver LA bonne ligne.
    async findProvenancesBatch(sourceId, occurrenceKeys) {
      const keys = [...new Set(occurrenceKeys)];
      if (!keys.length) return [];
      const rows = [];
      for (const chunk of chunkIds(keys, PRELOAD_CHUNK_SIZE)) rows.push(...await one(client.from("sortir_provenances").select("*").eq("source_id", sourceId).in("source_occurrence_key", chunk)));
      return rows;
    },
    async getActivity(id) { return one(client.from("sortir_activities").select("*, provenances:sortir_provenances(*, source:sortir_sources(key,connector_type,base_url)), external_ids:sortir_external_ids(*)").eq("id", id).single()); },
    async getActivitiesBatch(ids) {
      const unique = [...new Set(ids)];
      if (!unique.length) return [];
      const rows = [];
      for (const chunk of chunkIds(unique, PRELOAD_CHUNK_SIZE)) rows.push(...await one(client.from("sortir_activities").select("*, provenances:sortir_provenances(*, source:sortir_sources(key,connector_type,base_url)), external_ids:sortir_external_ids(*)").in("id", chunk)));
      return rows;
    },
    async listCandidateActivities(activity) { const start = new Date(Date.parse(activity.startsAt) - 12 * 60 * 60 * 1000).toISOString(); const end = new Date(Date.parse(activity.startsAt) + 12 * 60 * 60 * 1000).toISOString(); return one(client.from("sortir_activities").select("*, provenances:sortir_provenances(*, source:sortir_sources(key,connector_type,base_url)), external_ids:sortir_external_ids(*)").in("record_status", ["active", "review"]).gte("starts_at", start).lte("starts_at", end).limit(500)); },
    createActivity: (row) => one(client.from("sortir_activities").insert(row).select().single()),
    updateActivity: (id, row) => one(client.from("sortir_activities").update(row).eq("id", id).select().single()),
    markActivityMerged: (id, canonicalId) => one(client.from("sortir_activities").update({ record_status: "merged", merged_into_id: canonicalId, updated_at: new Date().toISOString() }).eq("id", id).select().single()),
    async updateProvenance(id, row) { return one(client.from("sortir_provenances").update(row).eq("id", id).select().single()); },
    async moveProvenances(fromId, toId) { const { error } = await client.from("sortir_provenances").update({ activity_id: toId }).eq("activity_id", fromId); if (error) throw new Error(error.message); },
    async moveExternalIds(fromId, toId) { const ids = await one(client.from("sortir_external_ids").select("source_id,system,value").eq("activity_id", fromId)); if (ids.length) { const { error } = await client.from("sortir_external_ids").upsert(ids.map((id) => ({ ...id, activity_id: toId })), { onConflict: "activity_id,source_id,system,value", ignoreDuplicates: true }); if (error) throw new Error(error.message); } const { error } = await client.from("sortir_external_ids").delete().eq("activity_id", fromId); if (error) throw new Error(error.message); },
    async createProvenanceIdempotent(row) { const { data, error } = await client.from("sortir_provenances").insert(row).select().single(); if (!error) return data; if (error.code !== "23505") throw new Error(error.message); const existing = await this.findProvenance(row.source_id, row.source_record_id, row.source_occurrence_key); if (!existing) throw new Error(error.message); return existing; },
    async upsertExternalIds(activityId, sourceId, ids) { if (!ids.length) return; const { error } = await client.from("sortir_external_ids").upsert(ids.map((id) => ({ activity_id: activityId, source_id: sourceId, system: id.system, value: id.value })), { onConflict: "activity_id,source_id,system,value", ignoreDuplicates: true }); if (error) throw new Error(error.message); },
    insertCollectionItem: (row) => one(client.from("sortir_collection_items").insert(row).select().single()),
    async insertDedupDecision(row) { if (row.left_activity_id === row.right_activity_id) return null; const ordered = row.left_activity_id < row.right_activity_id ? row : { ...row, left_activity_id: row.right_activity_id, right_activity_id: row.left_activity_id }; const { data, error } = await client.from("sortir_dedup_decisions").insert(ordered).select().single(); if (!error) return data; if (error.code === "23505") return null; throw new Error(error.message); },
    async applyDisappearances({ sourceId, sourceRunId, cutoff }) {
      const stale = await one(client.from("sortir_provenances").update({ active: false }).eq("source_id", sourceId).eq("active", true).or(`last_seen_run_id.is.null,last_seen_run_id.neq.${sourceRunId}`).lt("last_seen_at", cutoff).select("activity_id"));
      const touchedIds = [...new Set(stale.map(({ activity_id: id }) => id))];
      if (!touchedIds.length) return;
      // Remplace le COUNT par activité (N+1) par une poignée de lectures groupées : on
      // récupère les activity_id ayant ENCORE au moins une provenance active parmi celles
      // touchées, puis on marque stale uniquement la différence — même règle métier
      // (aucune provenance active restante ⇒ stale), sans boucle par activité.
      const stillActiveIds = new Set();
      for (const chunk of chunkIds(touchedIds)) {
        const rows = await one(client.from("sortir_provenances").select("activity_id").in("activity_id", chunk).eq("active", true));
        for (const { activity_id: id } of rows) stillActiveIds.add(id);
      }
      const idsToMarkStale = touchedIds.filter((id) => !stillActiveIds.has(id));
      if (!idsToMarkStale.length) return;
      const updatedAt = new Date().toISOString();
      for (const chunk of chunkIds(idsToMarkStale)) {
        const { error } = await client.from("sortir_activities").update({ record_status: "stale", updated_at: updatedAt }).in("id", chunk);
        if (error) throw new Error(error.message);
      }
    },
    async countFinalActivities() { const { count, error } = await client.from("sortir_activities").select("id", { count: "exact", head: true }).eq("record_status", "active"); if (error) throw new Error(error.message); return count || 0; }
  };
}
function createDefaultSupabaseStore() {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SECRET_KEY absentes");
  return createSupabaseSortirStore(createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }));
}

module.exports = { DEFAULT_STALE_AFTER_MS, DISAPPEARANCE_CHUNK_SIZE, PRELOAD_CHUNK_SIZE, chunkIds, provenanceMapKey, stableJson, payloadHash, sanitizeSourcePayload, canonicalActivityPayload, activityToRow, rowToActivity, persistSortirIngestion, mergeStoredActivities, createSupabaseSortirStore, createDefaultSupabaseStore };
