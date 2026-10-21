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
// Même borne et même justification que DISAPPEARANCE_CHUNK_SIZE : .in("id", chunk) sur des
// UUID courts (~36 caractères) — getActivitiesBatch, touchProvenancesBatch, et la taille des
// lots pour insertCollectionItemsBatch (un INSERT, pas un .in(), donc la longueur d'URL n'y
// joue aucun rôle). Jamais utilisée pour un .in() sur source_occurrence_key, voir
// OCCURRENCE_KEY_CHUNK_SIZE ci-dessous.
const PRELOAD_CHUNK_SIZE = 500;
// source_occurrence_key n'est PAS un UUID court : les clés réelles OpenAgenda
// ("openagenda:<uid>:<date ISO complète>") font ~70-85 caractères. Mesuré en conditions
// réelles le 18/10/2026 sur le lot Senlis (206 occurrences) : 170 clés (~14 262 octets d'URL)
// passent, 190 clés (~15 941 octets) échouent (`fetch failed`, probablement une limite
// d'en-tête/URL HTTP autour de 16 Ko). 100 laisse une marge large sans chercher à calculer la
// longueur exacte de l'URL — le coût de quelques SELECT supplémentaires est négligeable face
// au risque de dépasser à nouveau une limite non documentée précisément.
const OCCURRENCE_KEY_CHUNK_SIZE = 100;
// listCandidateActivitiesInRange retourne des lignes complètes via .range() (pagination par
// offset, pas un .in() sur des clés textuelles) : aucune limite d'URL ici, contrairement à
// OCCURRENCE_KEY_CHUNK_SIZE. Même borne que PRELOAD_CHUNK_SIZE par cohérence, sans raison de
// diverger avant mesure.
const CANDIDATE_RANGE_PAGE_SIZE = 500;
let ingestionQueue = Promise.resolve();

// Fusionne par (system, value), sans jamais supprimer une valeur déjà connue : reflète
// exactement la sémantique d'upsertExternalIds (INSERT ... ON CONFLICT DO NOTHING), jamais un
// DELETE. Utilisé uniquement pour tenir à jour candidateIndex en mémoire (voir
// persistSortirIngestionUnlocked) sans jamais relire l'activité en base après chaque écriture.
function unionExternalIds(existingIds, newIds) {
  const seen = new Set((existingIds || []).map((id) => `${id.system}\u0000${id.value}`));
  const merged = [...(existingIds || [])];
  for (const id of newIds || []) {
    const key = `${id.system}\u0000${id.value}`;
    if (!seen.has(key)) { seen.add(key); merged.push({ system: id.system, value: id.value }); }
  }
  return merged;
}

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
    legacySourceOccurrenceKey: item.legacySourceOccurrenceKey || null,
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

// Réconciliation explicite, réutilisable pour le stock et les chunks futurs. Les
// provenances déjà inactives sont aussi relues : un échec après la désactivation
// doit pouvoir reprendre la mise en stale lors du rejeu, sans perdre les activités.
async function reconcileDatatourismeRefusals({ store, sourceId, refusedPoiUuids, now = new Date() }) {
  const uuids = [...new Set(refusedPoiUuids || [])];
  if (!uuids.length) return { affectedActivityIds: [], staleActivityIds: [] };
  if (uuids.some((id) => typeof id !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error("UUID DATAtourisme refusé invalide");
  }
  const provenances = await store.findDatatourismeProvenancesByPoiUuids(sourceId, uuids);
  const activeIds = provenances.filter((p) => p.active).map((p) => p.id);
  if (activeIds.length) await store.touchProvenancesBatch(activeIds, { active: false });
  const affectedActivityIds = [...new Set(provenances.map((p) => p.activity_id))];
  const activities = await store.getActivitySupportBatch(affectedActivityIds);
  const staleActivityIds = activities.filter((a) =>
    ["active", "review"].includes(a.record_status) && !a.provenances.length
  ).map((a) => a.id);
  if (staleActivityIds.length) await store.markActivitiesStaleBatch(staleActivityIds, now.toISOString());
  return { affectedActivityIds, staleActivityIds };
}

async function persistSortirIngestionUnlocked({ sources, store, now = new Date(), staleAfterMs = DEFAULT_STALE_AFTER_MS }) {
  if (!store) throw new Error("store est obligatoire");
  const startedAt = now.toISOString();
  const ingestion = await store.createIngestionRun({ status: "running", orchestrator_version: ORCHESTRATOR_VERSION, started_at: startedAt });
  const totals = { collected: 0, VALID: 0, NEEDS_REVIEW: 0, INVALID: 0, merged: 0, toReview: 0, final: 0 };
  const sourceOutcomes = [];

  // Index EN MÉMOIRE des candidats pour les nouvelles occurrences (remplace les appels
  // individuels à listCandidateActivities). Déclaré ICI, au niveau de tout l'appel -- JAMAIS
  // réinitialisé entre deux sources -- parce qu'un candidat n'est pas filtré par source
  // (contrairement à provenanceMap/activityMap ci-dessous, nécessairement par source puisque
  // l'identité de provenance inclut source_id) : une activité créée en traitant la source A doit
  // rester visible comme candidate pour la source B traitée ensuite DANS LE MÊME appel. La
  // visibilité ENTRE deux appels séparés à persistSortirIngestion() n'a pas besoin d'être portée
  // par cet index : ingestionQueue sérialise déjà tous les appels (jamais deux en parallèle), et
  // le préchargement ci-dessous relit l'état réellement commité en base à chaque appel -- un
  // appel antérieur déjà terminé y est donc déjà visible, exactement comme l'aurait été une
  // relecture live de listCandidateActivities.
  const candidateIndex = new Map();
  // startsAtIso : chaîne ISO (comme activity.startsAt), jamais un Date déjà parsé par l'appelant.
  function candidateMatches(startsAtIso) {
    const t = Date.parse(startsAtIso);
    const result = [];
    for (const row of candidateIndex.values()) {
      if (!["active", "review"].includes(row.record_status)) continue;
      if (Math.abs(Date.parse(row.starts_at) - t) <= 12 * 60 * 60 * 1000) result.push(row);
    }
    return result;
  }
  // scalarRow : résultat brut d'un createActivity/updateActivity/markActivityMerged (colonnes de
  // sortir_activities uniquement, sans jointures) -- provenances/externalIds doivent être
  // fournis explicitement par l'appelant (voir les sites d'appel), jamais redérivés d'un ancien
  // contenu de l'index, pour ne jamais perdre silencieusement une provenance/un externalId déjà
  // connu.
  function setCandidateIndexEntry(scalarRow, provenances, externalIds) {
    candidateIndex.set(scalarRow.id, { ...scalarRow, provenances: provenances || [], external_ids: externalIds || [] });
  }

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
      // (MATCH/REVIEW/DISTINCT/création : décision inchangée -- seule la LECTURE des candidats
      // change, voir candidateIndex/listCandidateActivitiesInRange ci-dessous).
      const preloadOccurrenceKeys = new Set();
      // mapKey -> startsAt (ms) de CETTE occurrence, pour le préchargement conditionnel des
      // candidats ci-dessous (uniquement pour les clés qui s'avèrent absentes de provenanceMap,
      // donc génuinement nouvelles) -- aucune revalidation supplémentaire : construit dans ce
      // même pré-passage, déjà pur/sans effet de bord.
      const preloadStartsAtByMapKey = new Map();
      const legacyDatatourismeItems = [];
      for (const connectorResult of descriptor.results) {
        try {
          const wrapped = connectorResult && typeof connectorResult === "object" && ("activity" in connectorResult || "error" in connectorResult);
          if (wrapped && connectorResult.error) continue;
          const activityInput = wrapped ? connectorResult.activity : connectorResult;
          const validation = validateNormalizedActivity(activityInput);
          if (validation.status === "INVALID") continue;
          const item = { ...(wrapped ? connectorResult : {}), activity: validation.activity };
          const itemMetadata = sourceMetadata(item, source);
          preloadOccurrenceKeys.add(itemMetadata.sourceOccurrenceKey);
          if (descriptor.connectorType === "datatourisme" && itemMetadata.legacySourceOccurrenceKey) {
            preloadOccurrenceKeys.add(itemMetadata.legacySourceOccurrenceKey);
            legacyDatatourismeItems.push({ metadata: itemMetadata, endsAt: validation.activity.endsAt });
          }
          preloadStartsAtByMapKey.set(provenanceMapKey(itemMetadata.sourceRecordId, itemMetadata.sourceOccurrenceKey), Date.parse(validation.activity.startsAt));
        } catch (_) { /* erreur de préparation : re-détectée et comptabilisée dans la boucle principale */ }
      }
      const preloadedProvenances = await store.findProvenancesBatch(source.id, [...preloadOccurrenceKeys]);
      const provenanceMap = new Map(preloadedProvenances.map((row) => [provenanceMapKey(row.source_record_id, row.source_occurrence_key), row]));
      const preloadActivityIds = [...new Set(preloadedProvenances.map((row) => row.activity_id))];
      const preloadedActivities = await store.getActivitiesBatch(preloadActivityIds);
      const activityMap = new Map(preloadedActivities.map((row) => [row.id, row]));
      for (const { metadata, endsAt } of legacyDatatourismeItems) {
        const key = provenanceMapKey(metadata.sourceRecordId, metadata.sourceOccurrenceKey);
        if (provenanceMap.has(key)) continue;
        const legacy = provenanceMap.get(provenanceMapKey(metadata.sourceRecordId, metadata.legacySourceOccurrenceKey));
        const existing = legacy && activityMap.get(legacy.activity_id);
        // Même début (dans la clé historique) ET même fin canonique : aucune création
        // liée au seul changement de format. Une autre fin reste une autre période.
        if (existing && (existing.ends_at == null && endsAt == null || Date.parse(existing.ends_at) === Date.parse(endsAt))) {
          provenanceMap.set(key, legacy);
        }
      }
      // Préchargement des CANDIDATS (remplace les futurs appels individuels à
      // listCandidateActivities) -- déclenché UNIQUEMENT si cette source a au moins une
      // occurrence qui s'avère absente de provenanceMap (génuinement nouvelle) : sur un lot où
      // tout est déjà connu (cas quotidien dominant), aucun appel supplémentaire n'est fait, pour
      // ne pas régresser ce cas déjà optimisé par le chemin "provenance connue" ci-dessus. La
      // fenêtre couvre exactement l'union des ±12h de CES occurrences-là (même règle que
      // l'ancien appel par occurrence), jamais un seuil de jours arbitraire -- une fenêtre large
      // (ex. lot étalé sur plusieurs mois) reste correcte, juste paginée (voir
      // listCandidateActivitiesInRange), sans jamais tronquer silencieusement au-delà de 500
      // comme le faisait l'ancien appel borné par .limit(500).
      let minNewStartsAtMs = Infinity;
      let maxNewStartsAtMs = -Infinity;
      for (const [mapKey, startsAtMs] of preloadStartsAtByMapKey) {
        if (provenanceMap.has(mapKey) || !Number.isFinite(startsAtMs)) continue;
        if (startsAtMs < minNewStartsAtMs) minNewStartsAtMs = startsAtMs;
        if (startsAtMs > maxNewStartsAtMs) maxNewStartsAtMs = startsAtMs;
      }
      if (minNewStartsAtMs <= maxNewStartsAtMs) {
        const rangeStart = new Date(minNewStartsAtMs - 12 * 60 * 60 * 1000).toISOString();
        const rangeEnd = new Date(maxNewStartsAtMs + 12 * 60 * 60 * 1000).toISOString();
        const fetchedCandidates = await store.listCandidateActivitiesInRange(rangeStart, rangeEnd);
        for (const row of fetchedCandidates) candidateIndex.set(row.id, row);
      }
      // pendingProvenanceTouchIds : cas ultra-fréquent uniquement (occurrence connue, hash
      // identique, activité non-stale) — les écritures ne varient pas d'un item à l'autre
      // (mêmes last_seen_at/active/last_seen_run_id pour toute la source, aucune autre colonne
      // modifiée), donc accumulées ici puis écrites en un UPDATE groupé après la boucle. Les
      // cas stale/hash différent restent exécutés individuellement pour toutes leurs AUTRES
      // écritures (updateProvenance/upsertExternalIds/updateActivity/mergeActivities),
      // inchangés — seule la ligne d'historique (collection_items, ci-dessous) est différée.
      //
      // pendingCollectionItems : la ligne d'historique sortir_collection_items est toujours
      // indépendante — activity_id/provenance_id y sont déjà définitivement connus au moment
      // où on l'écrit, qu'il s'agisse d'une occurrence connue ultra-fréquente OU d'une
      // nouvelle occurrence (MATCH/REVIEW/DISTINCT, voir la fin de la boucle). Les deux
      // alimentent ce même tampon, vidé en un seul INSERT groupé après la boucle. Seuls les cas
      // stale et hash-différent gardent leur propre INSERT individuel (voir plus bas), pour ne
      // pas complexifier ces chemins déjà exceptionnels.
      const pendingProvenanceTouchIds = [];
      const pendingCollectionItems = [];

      for (let index = 0; index < (Array.isArray(descriptor.results) ? descriptor.results : []).length; index += 1) {
        const connectorResult = descriptor.results[index];
        counts.collected += 1; totals.collected += 1;
        let unlinkedActivityId = null;
        let validationStatus = null;
        let deferCollectionItem = false;
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
            const temporalPayloadChanged = descriptor.connectorType === "datatourisme" && item.sourcePayload &&
              stableJson(provenance.source_payload) !== stableJson(metadata.sourcePayload);
            if (provenance.payload_hash === hash) {
              // Fast-path : le hash canonique confirme qu'aucune donnée métier de CETTE source
              // n'a changé depuis la dernière observation. mergeActivities()/upsertExternalIds()
              // produiraient par construction le même résultat déjà stocké — jamais exécutés.
              // La provenance est quand même revue à chaque passage (last_seen_at/
              // last_seen_run_id/active, nécessaires à applyDisappearances), et l'activité est
              // réactivée si (et seulement si) elle était retombée stale — jamais de merge complet
              // pour ce seul changement de statut : record_status/updated_at suffisent.
              if (existing.record_status === "stale") {
                // Cas rare (réactivation) : chemin individuel conservé tel quel, pour ne pas
                // complexifier le cas ultra-fréquent ci-dessous.
                await store.updateProvenance(provenance.id, { last_seen_at: startedAt, active: true, last_seen_run_id: sourceRun.id, ...(temporalPayloadChanged ? { source_payload: metadata.sourcePayload } : {}) });
                const updated = await store.updateActivity(existing.id, { record_status: "active", updated_at: startedAt });
                // Une activité fusionnée peut recevoir plusieurs provenances DANS le même lot :
                // si un item ultérieur du même lot pointe vers cette même activité, il doit voir
                // ce nouvel état (record_status), pas la photo prise au début du run. Les clés
                // provenances/external_ids de la photo restent volontairement inchangées : ni
                // activityToRow() ni upsertExternalIds() ne les lisent jamais sur CE chemin
                // (provenances/externalIds persistées séparément, jamais via ces colonnes), donc
                // leur péremption éventuelle ici est sans effet observable.
                activityMap.set(existing.id, { ...existing, ...updated });
                // existing.record_status passe de "stale" à "active" : si candidateIndex la
                // contenait déjà (statut alors exclu par candidateMatches), elle doit redevenir
                // sélectionnable pour une NOUVELLE occurrence traitée plus loin dans ce même lot
                // -- provenances/external_ids inchangés (voir le commentaire ci-dessus).
                setCandidateIndexEntry({ ...existing, ...updated }, existing.provenances, existing.external_ids);
                await store.insertCollectionItem({ source_run_id: sourceRun.id, provenance_id: provenance.id, activity_id: existing.id, validation_status: validation.status, diagnostics: { errors: validation.errors, warnings: validation.warnings, sourceIndex: index } });
              } else if (temporalPayloadChanged) {
                await store.updateProvenance(provenance.id, { last_seen_at: startedAt, active: true, last_seen_run_id: sourceRun.id, source_payload: metadata.sourcePayload });
                pendingCollectionItems.push({ source_run_id: sourceRun.id, provenance_id: provenance.id, activity_id: existing.id, validation_status: validation.status, diagnostics: { errors: validation.errors, warnings: validation.warnings, sourceIndex: index } });
              } else {
                // Cas ultra-fréquent : ni la provenance ni l'activité ne changent de contenu.
                // Différé en lot — voir le flush après la boucle.
                pendingProvenanceTouchIds.push(provenance.id);
                pendingCollectionItems.push({ source_run_id: sourceRun.id, provenance_id: provenance.id, activity_id: existing.id, validation_status: validation.status, diagnostics: { errors: validation.errors, warnings: validation.warnings, sourceIndex: index } });
              }
              continue;
            } else {
              const merged = mergeActivities(rowToActivity(existing), validation.activity).activity;
              await store.updateProvenance(provenance.id, { last_seen_at: startedAt, active: true, last_seen_run_id: sourceRun.id, payload_hash: hash, source_payload: metadata.sourcePayload });
              await store.upsertExternalIds(existing.id, source.id, validation.activity.externalIds);
              const updated = await store.updateActivity(existing.id, activityToRow(merged, existing.record_status === "stale" ? "active" : existing.record_status));
              activityMap.set(existing.id, { ...existing, ...updated });
              // Contenu fusionné + externalIds de CETTE occurrence upsertés ci-dessus : tient
              // candidateIndex à jour pour les mêmes raisons que la réactivation ci-dessus
              // (provenances inchangées : même provenance, seul son contenu/hash a changé).
              setCandidateIndexEntry({ ...existing, ...updated }, existing.provenances, unionExternalIds(existing.external_ids, validation.activity.externalIds));
            }
            provenance = { ...provenance, payload_hash: hash, source_payload: metadata.sourcePayload };
            provenanceMap.set(provenanceMapKey(metadata.sourceRecordId, metadata.sourceOccurrenceKey), provenance);
            activityId = existing.id;
          } else {
            const candidates = candidateMatches(validation.activity.startsAt);
            const comparisons = candidates.map((candidate) => ({ candidate, result: compareActivities(rowToActivity(candidate), validation.activity) }));
            const match = validation.status === "VALID" ? comparisons.find((entry) => entry.result.decision === DECISIONS.MATCH) : null;
            const reviews = comparisons.filter((entry) => entry.result.decision === DECISIONS.REVIEW);
            let createdActivityId = null;
            let desiredRecordStatus = null;
            // indexScalarRow/basePriorProvenances/basePriorExternalIds : état de l'activité
            // GAGNANTE pour cette occurrence, tenu à jour au fil des écritures ci-dessous, pour
            // rafraîchir candidateIndex EN MÉMOIRE à la fin du bloc sans jamais relire l'activité
            // en base (sauf le cas de course déjà existant, qui le faisait déjà avant cette
            // étape).
            let indexScalarRow;
            let basePriorProvenances = [];
            let basePriorExternalIds = [];
            // provenanceAlreadyIndexed : vrai uniquement dans le cas de course ci-dessous, où la
            // provenance renvoyée par createProvenanceIdempotent n'est pas une nouvelle ligne
            // créée par CETTE occurrence mais la ligne déjà existante en conflit -- donc déjà
            // comprise dans raced.provenances, jamais à ajouter une seconde fois.
            let provenanceAlreadyIndexed = false;
            if (match) {
              const merged = mergeActivities(rowToActivity(match.candidate), validation.activity).activity;
              const updatedRow = await store.updateActivity(match.candidate.id, activityToRow(merged, match.candidate.record_status));
              await store.insertDedupDecision({ ingestion_run_id: ingestion.id, left_activity_id: match.candidate.id, right_activity_id: match.candidate.id, decision: "MATCH", algorithm_version: ALGORITHM_VERSION, signals: match.result.signals, review_status: "not_required" });
              activityId = match.candidate.id; totals.merged += 1;
              indexScalarRow = { ...match.candidate, ...updatedRow };
              basePriorProvenances = match.candidate.provenances || [];
              basePriorExternalIds = match.candidate.external_ids || [];
            } else {
              const underReview = validation.status === "NEEDS_REVIEW" || reviews.length > 0;
              desiredRecordStatus = underReview ? "review" : "active";
              const created = await store.createActivity(activityToRow(validation.activity, underReview ? "review" : "stale"));
              activityId = created.id; createdActivityId = created.id; unlinkedActivityId = created.id;
              indexScalarRow = created;
              if (underReview) { totals.toReview += 1; }
              for (const review of reviews) await store.insertDedupDecision({ ingestion_run_id: ingestion.id, left_activity_id: review.candidate.id, right_activity_id: created.id, decision: "REVIEW", algorithm_version: ALGORITHM_VERSION, signals: review.result.signals, review_status: "pending" });
            }
            provenance = await store.createProvenanceIdempotent({ activity_id: activityId, source_id: source.id, source_record_id: metadata.sourceRecordId, source_occurrence_key: metadata.sourceOccurrenceKey, original_event_url: metadata.originalEventUrl, source_payload: metadata.sourcePayload, payload_hash: hash, first_seen_at: startedAt, last_seen_at: startedAt, last_seen_run_id: sourceRun.id, active: true });
            unlinkedActivityId = null;
            if (provenance.activity_id !== activityId) {
              const raced = await store.getActivity(provenance.activity_id);
              const merged = mergeActivities(rowToActivity(raced), validation.activity).activity;
              const updatedRow = await store.updateActivity(raced.id, activityToRow(merged, raced.record_status === "stale" ? "active" : raced.record_status));
              if (createdActivityId) await store.markActivityMerged(createdActivityId, raced.id);
              activityId = provenance.activity_id;
              // L'activité créée localement a perdu la course : jamais indexée (elle devient
              // "merged", de toute façon exclue de candidateMatches). L'activité réellement
              // gagnante (raced) remplace l'état indexé précédent -- provenance est ici la ligne
              // déjà existante en conflit, déjà comprise dans raced.provenances.
              indexScalarRow = { ...raced, ...updatedRow };
              basePriorProvenances = raced.provenances || [];
              basePriorExternalIds = raced.external_ids || [];
              provenanceAlreadyIndexed = true;
            }
            await store.upsertExternalIds(activityId, source.id, validation.activity.externalIds);
            if (createdActivityId && provenance.activity_id === createdActivityId && desiredRecordStatus === "active") {
              const reactivated = await store.updateActivity(createdActivityId, { record_status: "active", updated_at: startedAt });
              indexScalarRow = { ...indexScalarRow, ...reactivated };
            }
            // Rafraîchit candidateIndex EN MÉMOIRE (zéro appel Supabase supplémentaire) : la
            // provenance de CETTE occurrence vient d'être créée/rattachée à activityId
            // (createProvenanceIdempotent ci-dessus) -- une occurrence suivante DANS LE MÊME lot
            // (même source ou une autre, voir la portée de candidateIndex en tête de fonction)
            // doit la voir sans jamais revenir en base, exactement comme l'aurait fait une
            // relecture live de listCandidateActivities.
            // source est ici la ligne RETOURNÉE par ensureSource() (snake_case : connector_type/
            // base_url), jamais le descripteur d'entrée (connectorType/baseUrl) -- une confusion
            // ici ferait silencieusement échouer provenanceCompatible() (sourceUrl/sourceType
            // absents), masquant les vrais MATCH intra-lot/inter-sources.
            const provenanceForIndex = { ...provenance, source: { key: source.key, connector_type: source.connector_type, base_url: source.base_url } };
            const finalProvenances = provenanceAlreadyIndexed ? basePriorProvenances : [...basePriorProvenances, provenanceForIndex];
            setCandidateIndexEntry(indexScalarRow, finalProvenances, unionExternalIds(basePriorExternalIds, validation.activity.externalIds));
            provenanceMap.set(provenanceMapKey(metadata.sourceRecordId, metadata.sourceOccurrenceKey), provenance);
            activityMap.set(activityId, { ...indexScalarRow, provenances: finalProvenances, external_ids: unionExternalIds(basePriorExternalIds, validation.activity.externalIds) });
            // Nouvelle occurrence (MATCH/REVIEW/DISTINCT) : activity_id/provenance_id sont déjà
            // définitivement connus à ce stade (après la résolution de course éventuelle
            // ci-dessus) — différé en lot, comme le cas ultra-fréquent des occurrences connues,
            // au lieu d'un INSERT individuel par occurrence.
            deferCollectionItem = true;
          }
          if (deferCollectionItem) {
            pendingCollectionItems.push({ source_run_id: sourceRun.id, provenance_id: provenance.id, activity_id: activityId, validation_status: validation.status, diagnostics: { errors: validation.errors, warnings: validation.warnings, sourceIndex: index } });
          } else {
            await store.insertCollectionItem({ source_run_id: sourceRun.id, provenance_id: provenance.id, activity_id: activityId, validation_status: validation.status, diagnostics: { errors: validation.errors, warnings: validation.warnings, sourceIndex: index } });
          }
        } catch (error) {
          if (!validationStatus) { counts.INVALID += 1; totals.INVALID += 1; }
          errors.push(`élément ${index}: ${errorText(error)}`); sourceStatus = "partial";
          if (unlinkedActivityId) { try { await store.updateActivity(unlinkedActivityId, { record_status: "stale", updated_at: startedAt }); } catch (_) {} }
          try { await store.insertCollectionItem({ source_run_id: sourceRun.id, validation_status: validationStatus || "INVALID", diagnostics: { sourceIndex: index, persistenceError: errorText(error) } }); } catch (_) {}
        }
      }

      // Deux lots séquentiels, jamais une pseudo-transaction : chaque appel est un aller-retour
      // HTTP indépendant. Ordre volontaire — la fraîcheur des provenances (lue par
      // applyDisappearances) est priorisée avant l'historique (purement consultatif, jamais relu
      // par la logique métier) : si un seul des deux doit échouer, mieux vaut un historique
      // incomplet qu'une provenance activement vue mais jamais marquée comme telle.
      if (pendingProvenanceTouchIds.length) {
        try {
          await store.touchProvenancesBatch(pendingProvenanceTouchIds, { last_seen_at: startedAt, active: true, last_seen_run_id: sourceRun.id });
        } catch (error) {
          sourceStatus = sourceStatus === "completed" ? "partial" : sourceStatus;
          errors.push(`revue groupée des provenances inchangées: ${errorText(error)}`);
        }
      }
      if (pendingCollectionItems.length) {
        try {
          await store.insertCollectionItemsBatch(pendingCollectionItems);
        } catch (error) {
          sourceStatus = sourceStatus === "completed" ? "partial" : sourceStatus;
          errors.push(`historique groupé des occurrences inchangées: ${errorText(error)}`);
        }
      }
    }
    if (sourceStatus === "completed" && descriptor.connectorType === "datatourisme") {
      try {
        const reconciliation = await reconcileDatatourismeRefusals({ store, sourceId: source.id, refusedPoiUuids: descriptor.refusedPoiUuids, now });
        // Les sources suivantes rechargeront les candidats nécessaires depuis le store.
        // Ne jamais réutiliser une photo antérieure à la désactivation d'une provenance.
        for (const id of reconciliation.affectedActivityIds) candidateIndex.delete(id);
      } catch (error) {
        sourceStatus = "partial";
        errors.push(`refus éditoriaux DATAtourisme: ${errorText(error)}`);
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
    // État mutable minimal pour la reprise de pagination (ex. DATAtourisme, voir
    // sortir-auto-ingest.js) -- n'a aucun rôle dans persistSortirIngestionUnlocked, jamais lu ni
    // écrit par lui : utilisé uniquement par la couche d'orchestration, qui décide elle-même
    // quand lire/écrire (une lecture par cycle, une écriture après chaque chunk réussi).
    async getSourceCursor(key) { const { data, error } = await client.from("sortir_sources").select("resume_cursor").eq("key", key).maybeSingle(); if (error) throw new Error(error.message); return data ? data.resume_cursor : null; },
    async saveSourceCursor(key, cursor) { const { error } = await client.from("sortir_sources").update({ resume_cursor: cursor }).eq("key", key); if (error) throw new Error(error.message); },
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
      for (const chunk of chunkIds(keys, OCCURRENCE_KEY_CHUNK_SIZE)) rows.push(...await one(client.from("sortir_provenances").select("*").eq("source_id", sourceId).in("source_occurrence_key", chunk)));
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
    // Remplace l'ancien listCandidateActivities(activity) (requête individuelle ±12h, bornée à
    // .limit(500) donc silencieusement tronquante au-delà) : même filtre/colonnes/jointures,
    // mais sur la fenêtre [startIso, endIso] couvrant TOUT le lot de nouvelles occurrences d'une
    // source (voir persistSortirIngestionUnlocked), avec pagination par .range() -- jamais de
    // perte silencieuse, quel que soit le nombre de candidats réellement actifs/en revue sur la
    // période. .order("id") est nécessaire : .range() n'est stable/déterministe entre deux pages
    // que sur un tri explicite.
    async listCandidateActivitiesInRange(startIso, endIso) {
      const rows = [];
      let from = 0;
      while (true) {
        const page = await one(client.from("sortir_activities").select("*, provenances:sortir_provenances(*, source:sortir_sources(key,connector_type,base_url)), external_ids:sortir_external_ids(*)").in("record_status", ["active", "review"]).gte("starts_at", startIso).lte("starts_at", endIso).order("id", { ascending: true }).range(from, from + CANDIDATE_RANGE_PAGE_SIZE - 1));
        rows.push(...page);
        if (page.length < CANDIDATE_RANGE_PAGE_SIZE) break;
        from += CANDIDATE_RANGE_PAGE_SIZE;
      }
      return rows;
    },
    createActivity: (row) => one(client.from("sortir_activities").insert(row).select().single()),
    updateActivity: (id, row) => one(client.from("sortir_activities").update(row).eq("id", id).select().single()),
    markActivityMerged: (id, canonicalId) => one(client.from("sortir_activities").update({ record_status: "merged", merged_into_id: canonicalId, updated_at: new Date().toISOString() }).eq("id", id).select().single()),
    async updateProvenance(id, row) { return one(client.from("sortir_provenances").update(row).eq("id", id).select().single()); },
    // UPDATE groupé, pas un upsert : les mêmes valeurs (last_seen_at/active/last_seen_run_id)
    // s'appliquent à toutes les lignes du chunk, et un UPDATE ne touche jamais les colonnes
    // non listées (activity_id/source_id/source_record_id/source_occurrence_key/source_payload/
    // payload_hash/original_event_url/first_seen_at restent intactes) — aucun risque
    // d'écrasement, contrairement à un upsert multi-lignes qui aurait exigé de renvoyer
    // l'intégralité de ces colonnes pour chaque ligne.
    async touchProvenancesBatch(ids, touch) {
      const unique = [...new Set(ids)];
      if (!unique.length) return;
      for (const chunk of chunkIds(unique, PRELOAD_CHUNK_SIZE)) {
        const { error } = await client.from("sortir_provenances").update(touch).in("id", chunk);
        if (error) throw new Error(error.message);
      }
    },
    async moveProvenances(fromId, toId) { const { error } = await client.from("sortir_provenances").update({ activity_id: toId }).eq("activity_id", fromId); if (error) throw new Error(error.message); },
    async moveExternalIds(fromId, toId) { const ids = await one(client.from("sortir_external_ids").select("source_id,system,value").eq("activity_id", fromId)); if (ids.length) { const { error } = await client.from("sortir_external_ids").upsert(ids.map((id) => ({ ...id, activity_id: toId })), { onConflict: "activity_id,source_id,system,value", ignoreDuplicates: true }); if (error) throw new Error(error.message); } const { error } = await client.from("sortir_external_ids").delete().eq("activity_id", fromId); if (error) throw new Error(error.message); },
    async createProvenanceIdempotent(row) { const { data, error } = await client.from("sortir_provenances").insert(row).select().single(); if (!error) return data; if (error.code !== "23505") throw new Error(error.message); const existing = await this.findProvenance(row.source_id, row.source_record_id, row.source_occurrence_key); if (!existing) throw new Error(error.message); return existing; },
    async upsertExternalIds(activityId, sourceId, ids) { if (!ids.length) return; const { error } = await client.from("sortir_external_ids").upsert(ids.map((id) => ({ activity_id: activityId, source_id: sourceId, system: id.system, value: id.value })), { onConflict: "activity_id,source_id,system,value", ignoreDuplicates: true }); if (error) throw new Error(error.message); },
    insertCollectionItem: (row) => one(client.from("sortir_collection_items").insert(row).select().single()),
    // INSERT multi-lignes, chunké : lignes indépendantes, aucun résultat réutilisé ensuite
    // (contrairement à insertCollectionItem seul, jamais appelé avec .single() ici).
    async insertCollectionItemsBatch(rows) {
      if (!rows.length) return;
      for (const chunk of chunkIds(rows, PRELOAD_CHUNK_SIZE)) {
        const { error } = await client.from("sortir_collection_items").insert(chunk);
        if (error) throw new Error(error.message);
      }
    },
    async insertDedupDecision(row) { if (row.left_activity_id === row.right_activity_id) return null; const ordered = row.left_activity_id < row.right_activity_id ? row : { ...row, left_activity_id: row.right_activity_id, right_activity_id: row.left_activity_id }; const { data, error } = await client.from("sortir_dedup_decisions").insert(ordered).select().single(); if (!error) return data; if (error.code === "23505") return null; throw new Error(error.message); },
    // source_record_id est construit par le connecteur : datatourisme:{uuid}:{date}.
    // Le préfixe terminé par ':' vise toutes les occurrences historiques de CE POI,
    // sans confondre deux POI fusionnés dans une même activité. Les UUID sont validés
    // avant interpolation. 100 UUID par filtre borne la longueur des URL PostgREST.
    async findDatatourismeProvenancesByPoiUuids(sourceId, uuids) {
      const rows = [];
      for (const chunk of chunkIds(uuids, OCCURRENCE_KEY_CHUNK_SIZE)) {
        for (let from = 0; ; from += PRELOAD_CHUNK_SIZE) {
          const { data, count, error } = await client.from("sortir_provenances")
            .select("id,activity_id,active", { count: "exact" }).eq("source_id", sourceId)
            .or(chunk.map((uuid) => `source_record_id.like.datatourisme:${uuid}:*`).join(","))
            .order("id", { ascending: true }).range(from, from + PRELOAD_CHUNK_SIZE - 1);
          if (error) throw new Error(error.message);
          rows.push(...data);
          if (!data.length || from + data.length >= count) break;
        }
      }
      return rows;
    },
    async getActivitySupportBatch(ids) {
      const rows = [];
      for (const chunk of chunkIds(ids)) {
        // Jointure externe : garde les activités sans soutien ; limite embarquée à
        // une provenance active, pour éviter toute troncature liée à leur multiplicité.
        rows.push(...await one(client.from("sortir_activities")
          .select("id,record_status,provenances:sortir_provenances(id)").in("id", chunk)
          .eq("provenances.active", true).limit(1, { referencedTable: "provenances" })));
      }
      return rows;
    },
    async markActivitiesStaleBatch(ids, updatedAt) {
      for (const chunk of chunkIds(ids)) {
        const { error } = await client.from("sortir_activities")
          .update({ record_status: "stale", updated_at: updatedAt }).in("id", chunk)
          .in("record_status", ["active", "review"]);
        if (error) throw new Error(error.message);
      }
    },
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

module.exports = { reconcileDatatourismeRefusals, DEFAULT_STALE_AFTER_MS, DISAPPEARANCE_CHUNK_SIZE, PRELOAD_CHUNK_SIZE, OCCURRENCE_KEY_CHUNK_SIZE, CANDIDATE_RANGE_PAGE_SIZE, chunkIds, provenanceMapKey, unionExternalIds, stableJson, payloadHash, sanitizeSourcePayload, canonicalActivityPayload, activityToRow, rowToActivity, persistSortirIngestion, mergeStoredActivities, createSupabaseSortirStore, createDefaultSupabaseStore };
