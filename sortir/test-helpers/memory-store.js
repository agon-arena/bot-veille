"use strict";

// Store de simulation extrait de test-supabase-persistence.js. Aucun client réseau.
class MemoryStore {
  constructor() { this.seq = 0; this.sources = []; this.ingestions = []; this.sourceRuns = []; this.activities = []; this.provenances = []; this.externalIds = []; this.items = []; this.decisions = []; this.payloadWrites = 0; }
  id(prefix) { this.seq += 1; return `${prefix}-${this.seq}`; }
  async ensureSource(row) { let found = this.sources.find((x) => x.key === row.key); if (!found) { found = { id: this.id("src"), key: row.key, connector_type: row.connectorType, base_url: row.baseUrl }; this.sources.push(found); } return found; }
  async createIngestionRun(row) { const value = { id: this.id("ing"), ...row }; this.ingestions.push(value); return value; }
  async updateIngestionRun(id, row) { Object.assign(this.ingestions.find((x) => x.id === id), row); }
  async createSourceRun(row) { const value = { id: this.id("run"), ...row }; this.sourceRuns.push(value); return value; }
  async updateSourceRun(id, row) { Object.assign(this.sourceRuns.find((x) => x.id === id), row); }
  async findProvenance(sourceId, recordId, occurrenceKey) { return this.provenances.find((x) => x.source_id === sourceId && (x.source_record_id || "") === (recordId || "") && x.source_occurrence_key === occurrenceKey) || null; }
  async findProvenancesBatch(sourceId, occurrenceKeys) { const keys = new Set(occurrenceKeys); return this.provenances.filter((x) => x.source_id === sourceId && keys.has(x.source_occurrence_key)); }
  hydrate(row) { return { ...row, provenances: this.provenances.filter((p) => p.activity_id === row.id).map((p) => ({ ...p, source: this.sources.find((s) => s.id === p.source_id) })), external_ids: this.externalIds.filter((id) => id.activity_id === row.id) }; }
  async getActivity(id) { const row = this.activities.find((x) => x.id === id); if (!row) throw new Error("activité absente"); return this.hydrate(row); }
  async getActivitiesBatch(ids) { const set = new Set(ids); return this.activities.filter((x) => set.has(x.id)).map((x) => this.hydrate(x)); }
  async listCandidateActivitiesInRange(startIso, endIso) { const start = Date.parse(startIso), end = Date.parse(endIso); return this.activities.filter((x) => ["active", "review"].includes(x.record_status) && Date.parse(x.starts_at) >= start && Date.parse(x.starts_at) <= end).map((x) => this.hydrate(x)); }
  async createActivity(row) { const value = { id: this.id("act"), merged_into_id: null, ...row }; this.activities.push(value); return value; }
  async updateActivity(id, row) { const value = this.activities.find((x) => x.id === id); Object.assign(value, row); return value; }
  async markActivityMerged(id, canonicalId) { return this.updateActivity(id, { record_status: "merged", merged_into_id: canonicalId }); }
  async updateProvenance(id, row) { if (Object.prototype.hasOwnProperty.call(row, "source_payload")) this.payloadWrites += 1; const value = this.provenances.find((x) => x.id === id); Object.assign(value, row); return value; }
  async touchProvenancesBatch(ids, touch) { const set = new Set(ids); for (const p of this.provenances) if (set.has(p.id)) Object.assign(p, touch); }
  async moveProvenances(fromId, toId) { for (const p of this.provenances) if (p.activity_id === fromId) p.activity_id = toId; }
  async moveExternalIds(fromId, toId) { for (const id of this.externalIds.filter((x) => x.activity_id === fromId)) if (!this.externalIds.some((x) => x.activity_id === toId && x.source_id === id.source_id && x.system === id.system && x.value === id.value)) this.externalIds.push({ ...id, activity_id: toId }); this.externalIds = this.externalIds.filter((x) => x.activity_id !== fromId); }
  async createProvenanceIdempotent(row) { const existing = await this.findProvenance(row.source_id, row.source_record_id, row.source_occurrence_key); if (existing) return existing; const value = { id: this.id("prov"), ...row }; this.provenances.push(value); this.payloadWrites += 1; return value; }
  async upsertExternalIds(activityId, sourceId, ids) { for (const id of ids) if (!this.externalIds.some((x) => x.activity_id === activityId && x.source_id === sourceId && x.system === id.system && x.value === id.value)) this.externalIds.push({ activity_id: activityId, source_id: sourceId, system: id.system, value: id.value }); }
  async insertCollectionItem(row) { const value = { id: this.id("item"), ...row }; this.items.push(value); return value; }
  async insertCollectionItemsBatch(rows) { for (const row of rows) this.items.push({ id: this.id("item"), ...row }); }
  async insertDedupDecision(row) { if (row.left_activity_id === row.right_activity_id) return null; if (!this.decisions.some((x) => x.left_activity_id === row.left_activity_id && x.right_activity_id === row.right_activity_id && x.algorithm_version === row.algorithm_version)) this.decisions.push({ id: this.id("decision"), ...row }); }
  async applyDisappearances({ sourceId, sourceRunId, cutoff }) { const affected = new Set(); for (const p of this.provenances) if (p.source_id === sourceId && p.active && p.last_seen_run_id !== sourceRunId && p.last_seen_at < cutoff) { p.active = false; affected.add(p.activity_id); } for (const id of affected) if (!this.provenances.some((p) => p.activity_id === id && p.active)) await this.updateActivity(id, { record_status: "stale" }); }
  // Primitives groupées de la même interface que le store Supabase, sans réseau.
  async createActivitiesBatch(rows) { return Promise.all(rows.map(row => this.createActivity(row))); }
  async createProvenancesBatch(rows) { return Promise.all(rows.map(row => this.createProvenanceIdempotent(row))); }
  async insertDedupDecisionsBatch(rows) { for (const row of rows) await this.insertDedupDecision(row); }
  async upsertExternalIdsBatch(rows) { for (const row of rows) await this.upsertExternalIds(row.activity_id, row.source_id, [{ system: row.system, value: row.value }]); }
  async flipActivitiesBatch(ids, patch) { for (const id of ids) await this.updateActivity(id, patch); }
  async countFinalActivities() { return this.activities.filter((x) => x.record_status === "active").length; }
}

module.exports = { MemoryStore };
