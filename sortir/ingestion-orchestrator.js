"use strict";

const { validateNormalizedActivity } = require("./activity-validation");
const { DECISIONS, compareActivities, mergeActivities } = require("./activity-deduplication");

const ORCHESTRATOR_VERSION = "sortir-ingestion-v1";

function stableKey(item) {
  const activity = item.activity || {};
  const ids = Array.isArray(activity.externalIds) ? activity.externalIds.map((id) => `${id.system}:${id.value}`).sort().join("|") : "";
  const provenance = Array.isArray(activity.provenances) ? activity.provenances.map((p) => `${p.sourceName || ""}:${p.originalEventUrl || p.externalId || ""}`).sort().join("|") : "";
  return [activity.startsAt || "", String(activity.title || "").toLocaleLowerCase("fr-FR"), ids, provenance, item.source, item.sourceIndex].join("\u0000");
}

function normalizeSources(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === "object") return Object.entries(input).map(([source, value]) => ({ source, ...(Array.isArray(value) ? { results: value } : value) }));
  return [];
}

function ingestSortir(input) {
  const diagnostics = { sourceErrors: [], activityErrors: [], validations: [], comparisons: [], mergeErrors: [] };
  const collected = [];

  normalizeSources(input).forEach((sourceEntry, sourcePosition) => {
    const source = String(sourceEntry && (sourceEntry.source || sourceEntry.name) || `source-${sourcePosition + 1}`);
    if (sourceEntry && sourceEntry.error) {
      diagnostics.sourceErrors.push({ source, error: String(sourceEntry.error.message || sourceEntry.error) });
      return;
    }
    const results = sourceEntry && Array.isArray(sourceEntry.results) ? sourceEntry.results : [];
    if (!Array.isArray(sourceEntry && sourceEntry.results)) diagnostics.sourceErrors.push({ source, error: "Résultats absents ou non tabulaires." });
    results.forEach((result, sourceIndex) => {
      const wrapped = result && typeof result === "object" && (Object.prototype.hasOwnProperty.call(result, "activity") || Object.prototype.hasOwnProperty.call(result, "error"));
      const activity = wrapped ? result.activity : result;
      const connectorError = wrapped ? result.error : null;
      if (connectorError || !activity || typeof activity !== "object") {
        diagnostics.activityErrors.push({ source, sourceIndex, error: String(connectorError && (connectorError.message || connectorError) || "Activité absente ou invalide.") });
        collected.push({ source, sourceIndex, activity: null, validation: null, failed: true });
        return;
      }
      try {
        const validation = validateNormalizedActivity(activity);
        const item = { source, sourceIndex, activity: validation.activity, validation, failed: false };
        collected.push(item);
        diagnostics.validations.push({ source, sourceIndex, status: validation.status, errors: validation.errors, warnings: validation.warnings });
      } catch (error) {
        diagnostics.activityErrors.push({ source, sourceIndex, error: String(error.message || error) });
        collected.push({ source, sourceIndex, activity: null, validation: null, failed: true });
      }
    });
  });

  const valid = collected.filter((item) => item.validation && item.validation.status === "VALID").sort((a, b) => stableKey(a).localeCompare(stableKey(b)));
  const needsReview = collected.filter((item) => item.validation && item.validation.status === "NEEDS_REVIEW").sort((a, b) => stableKey(a).localeCompare(stableKey(b)));
  const invalid = collected.filter((item) => item.failed || item.validation && item.validation.status === "INVALID");
  const parent = valid.map((_, index) => index);
  const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (left, right) => { const a = find(left), b = find(right); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  const reviews = [];

  for (let left = 0; left < valid.length; left += 1) for (let right = left + 1; right < valid.length; right += 1) {
    try {
      const comparison = compareActivities(valid[left].activity, valid[right].activity);
      diagnostics.comparisons.push({ left: { source: valid[left].source, sourceIndex: valid[left].sourceIndex }, right: { source: valid[right].source, sourceIndex: valid[right].sourceIndex }, ...comparison });
      if (comparison.decision === DECISIONS.MATCH) union(left, right);
      else if (comparison.decision === DECISIONS.REVIEW) reviews.push({ left, right, comparison });
    } catch (error) {
      diagnostics.activityErrors.push({ source: `${valid[left].source}/${valid[right].source}`, sourceIndex: null, error: `Comparaison: ${error.message || error}` });
    }
  }

  const components = new Map();
  valid.forEach((item, index) => { const root = find(index); if (!components.has(root)) components.set(root, []); components.get(root).push(item); });
  const mergedComponents = new Map();
  let mergedCount = 0;
  for (const [root, items] of components) {
    let activity = items[0].activity;
    let failed = false;
    for (let index = 1; index < items.length; index += 1) {
      try { activity = mergeActivities(activity, items[index].activity).activity; mergedCount += 1; }
      catch (error) { diagnostics.mergeErrors.push({ sources: items.map((item) => item.source), error: String(error.message || error) }); failed = true; break; }
    }
    mergedComponents.set(root, { activity, members: items.map((item) => ({ source: item.source, sourceIndex: item.sourceIndex })), failed });
  }

  const reviewEdges = new Map();
  reviews.forEach((review) => {
    const leftRoot = find(review.left), rightRoot = find(review.right);
    if (leftRoot === rightRoot) return;
    const key = [leftRoot, rightRoot].sort((a, b) => a - b).join(":");
    if (!reviewEdges.has(key)) reviewEdges.set(key, { roots: [leftRoot, rightRoot].sort((a, b) => a - b), comparisons: [] });
    reviewEdges.get(key).comparisons.push(review.comparison);
  });
  const rootsUnderReview = new Set();
  const reviewQueue = needsReview.map((item) => ({ type: "validation", candidates: [item.activity], members: [{ source: item.source, sourceIndex: item.sourceIndex }], diagnostics: item.validation.warnings }));
  for (const edge of reviewEdges.values()) {
    edge.roots.forEach((root) => rootsUnderReview.add(root));
    reviewQueue.push({ type: "deduplication", candidates: edge.roots.map((root) => mergedComponents.get(root).activity), members: edge.roots.flatMap((root) => mergedComponents.get(root).members), diagnostics: edge.comparisons });
  }
  for (const [root, component] of mergedComponents) if (component.failed) {
    rootsUnderReview.add(root);
    reviewQueue.push({ type: "merge_error", candidates: [component.activity], members: component.members, diagnostics: diagnostics.mergeErrors.filter((item) => item.sources.some((source) => component.members.some((member) => member.source === source))) });
  }

  reviewQueue.sort((a, b) => JSON.stringify(a.members).localeCompare(JSON.stringify(b.members)) || a.type.localeCompare(b.type));
  const finalActivities = [...mergedComponents.entries()].filter(([root, component]) => !rootsUnderReview.has(root) && !component.failed).map(([, component]) => component.activity);
  finalActivities.sort((a, b) => stableKey({ activity: a, source: "", sourceIndex: 0 }).localeCompare(stableKey({ activity: b, source: "", sourceIndex: 0 })));

  return {
    orchestratorVersion: ORCHESTRATOR_VERSION,
    finalActivities,
    reviewQueue,
    invalidActivities: invalid.map((item) => ({ source: item.source, sourceIndex: item.sourceIndex, activity: item.activity, validation: item.validation })),
    diagnostics,
    stats: {
      collected: collected.length,
      VALID: valid.length,
      NEEDS_REVIEW: needsReview.length,
      INVALID: invalid.length,
      merged: mergedCount,
      toReview: reviewQueue.length,
      final: finalActivities.length
    }
  };
}

module.exports = { ORCHESTRATOR_VERSION, ingestSortir };
