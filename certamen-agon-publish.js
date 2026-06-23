// Publication Certamen → bulles Agôn uniquement. Chemin volontairement séparé du
// pipeline veille mixte (/send-to-agon, classifyAndPublishPending, suggestStoryLink) :
//
// /send-to-agon insère dans veille_pending, une file PARTAGÉE avec la veille mixte ; la
// publication réelle se fait ensuite via classifyAndPublishPending() qui republie/fusionne
// TOUS les items en attente dans cette file, y compris d'éventuels restes laissés par la
// veille mixte — hors scope Certamen et risque de blast radius non maîtrisé.
//
// On appelle donc directement POST {AGON_URL}/api/admin/veille/publish pour chaque
// payload "ready", sans passer par id/veille_pending : côté Agôn, sans id fourni, aucune
// pendingRow n'est chargée, donc aucun pending_story_selection ne peut être réutilisé.
// storySelection n'est jamais envoyé dans le corps de la requête.

const fs = require("fs");
const path = require("path");
const { getCheckedCertamenPayloadsPreview, filterPublishableCertamenPayloads } = require("./certamen-payload-validation");

const AGON_URL = (process.env.AGON_URL || "http://localhost:3001").trim();
const SENT_TO_AGON_FILE = path.join(__dirname, "sent-to-agon.json");
const MAX_PUBLISH_SUBJECTS = 10;
const PUBLISH_THROTTLE_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loginAgonAdminForCertamen() {
  const adminPassword = process.env.AGON_ADMIN_PASSWORD;
  if (!adminPassword) {
    console.log("[certamen-publish] AGON_ADMIN_PASSWORD absent — publication impossible");
    return null;
  }
  try {
    const loginRes = await fetch(`${AGON_URL}/api/admin/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: adminPassword })
    });
    if (!loginRes.ok) {
      console.error("[certamen-publish] Échec login admin Agôn");
      return null;
    }
    const { token } = await loginRes.json();
    return { "Content-Type": "application/json", "x-admin-token": token };
  } catch (err) {
    console.error("[certamen-publish] Erreur login Agôn :", err.message);
    return null;
  }
}

function loadSentToAgonForCertamen() {
  try {
    return JSON.parse(fs.readFileSync(SENT_TO_AGON_FILE, "utf8"));
  } catch {
    return [];
  }
}

function appendSentToAgonForCertamen(entry) {
  const items = loadSentToAgonForCertamen();
  items.unshift(entry);
  fs.writeFileSync(SENT_TO_AGON_FILE, JSON.stringify(items, null, 2), "utf8");
}

// Protection anti-doublon minimale : sent-to-agon.json est un historique partagé avec la
// veille mixte, donc on ne s'appuie que sur la question exacte déjà envoyée — pas de
// filtrage plus large par sujet/source qui pourrait être ambigu sur un fichier partagé.
function wasAlreadySentToAgon(question) {
  const q = String(question || "").trim();
  if (!q) return false;
  return loadSentToAgonForCertamen().some((item) => String(item?.question || "").trim() === q);
}

async function publishReadyCertamenPayloadsToAgon() {
  const preview = getCheckedCertamenPayloadsPreview();
  const readyPayloads = filterPublishableCertamenPayloads(preview.items).slice(0, MAX_PUBLISH_SUBJECTS);

  const result = {
    checkedCount: preview.items.length,
    readyCount: preview.readyCount,
    blockedCount: preview.blockedCount,
    needsReviewCount: preview.needsReviewCount,
    publishedCount: 0,
    skipped: [],
    results: []
  };

  if (!readyPayloads.length) {
    console.log("[certamen-publish] Aucun payload ready à publier.");
    return result;
  }

  const adminHeaders = await loginAgonAdminForCertamen();
  if (!adminHeaders) {
    result.results = readyPayloads.map((p) => ({ subject: p.subject, ok: false, error: "Login admin Agôn impossible" }));
    return result;
  }

  for (let i = 0; i < readyPayloads.length; i += 1) {
    const payload = readyPayloads[i];

    // Garde-fou absolu, vérifié juste avant l'envoi réseau : storySelection doit être
    // strictement null. Ne devrait jamais se déclencher (déjà forcé en amont par
    // validateAndCleanCertamenPayload), mais on bloque explicitement si jamais.
    if (payload.storySelection !== null) {
      console.error(`[certamen-publish] BLOQUÉ — storySelection non nul pour "${payload.subject}"`);
      result.results.push({ subject: payload.subject, ok: false, error: "storySelection non nul — publication refusée" });
      result.skipped.push(payload.subject);
      continue;
    }

    if (wasAlreadySentToAgon(payload.question)) {
      console.log(`[certamen-publish] Déjà envoyé, ignoré : "${String(payload.subject || "").slice(0, 60)}"`);
      result.skipped.push(payload.subject);
      result.results.push({ subject: payload.subject, ok: true, skipped: true, reason: "already_sent" });
      continue;
    }

    if (i > 0) await sleep(PUBLISH_THROTTLE_DELAY_MS);

    try {
      const r = await fetch(`${AGON_URL}/api/admin/veille/publish`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          question: payload.question,
          positionA: payload.positionA || "",
          positionB: payload.positionB || "",
          theme: payload.theme || "",
          resume: payload.resume || "",
          links: payload.links || [],
          keywords: payload.keywords || []
          // storySelection volontairement absent du corps envoyé à Agôn, et aucun "id"
          // de veille_pending n'est fourni : pas de pendingRow, donc pas de
          // pending_story_selection possible côté serveur Agôn.
        })
      });

      if (!r.ok) {
        const body = await r.text().catch(() => "");
        console.error(`[certamen-publish] Échec publication "${String(payload.subject || "").slice(0, 60)}" : ${r.status} ${body}`);
        result.results.push({ subject: payload.subject, ok: false, error: `Agôn a répondu ${r.status}: ${body}` });
        continue;
      }

      const data = await r.json().catch(() => ({}));
      console.log(`[certamen-publish] ✓ Publié : "${String(payload.subject || "").slice(0, 60)}" (debateId=${data.debateId || data.id || "?"})`);

      appendSentToAgonForCertamen({
        subject: payload.subject,
        question: payload.question,
        positionA: payload.positionA,
        positionB: payload.positionB,
        theme: payload.theme,
        resume: payload.resume,
        sources: payload.sources,
        links: payload.links,
        storySelection: null,
        arenaMode: payload.arenaMode,
        origin: "certamen",
        sentAt: new Date().toISOString()
      });

      result.publishedCount += 1;
      result.results.push({ subject: payload.subject, ok: true, debateId: data.debateId || data.id || null });
    } catch (err) {
      console.error(`[certamen-publish] Erreur réseau pour "${String(payload.subject || "").slice(0, 60)}" :`, err.message);
      result.results.push({ subject: payload.subject, ok: false, error: err.message });
    }
  }

  return result;
}

module.exports = {
  MAX_PUBLISH_SUBJECTS,
  publishReadyCertamenPayloadsToAgon
};
