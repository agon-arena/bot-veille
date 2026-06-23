// Publication Certamen → bulles Agôn, visuel "arène communauté". Chemin dédié,
// totalement séparé du pipeline veille mixte (/send-to-agon, classifyAndPublishPending,
// suggestStoryLink, /api/admin/veille/publish).
//
// Important : POST /api/admin/veille/publish (utilisé par la veille mixte) force
// `creator_key: AGON_ADMIN_CREATOR_KEY` en dur côté Agôn → is_official=true,
// is_community=false. Ce n'est PAS le visuel voulu pour Certamen.
//
// On publie donc via l'endpoint public POST /api/debates (le même que celui utilisé par
// un utilisateur qui crée un débat depuis l'app) avec un creatorKey réel et non-admin :
// côté Agôn, creator_key !== AGON_ADMIN_CREATOR_KEY ET truthy => is_community=true.
// Cet endpoint n'accepte même pas de paramètre storySelection : il ne peut
// structurellement pas créer de ligne dans "stories" (bulle actu).
//
// Limite connue de /api/debates : un seul source_url (pas de liste media_extras comme
// sur le tunnel admin). On tente, en best-effort et seulement si AGON_ADMIN_PASSWORD est
// configuré, d'attacher les sources restantes via PUT
// /api/admin/debate/:id/media-extras — un échec ou une absence de mot de passe admin
// n'empêche jamais la publication elle-même (qui ne dépend d'aucun accès admin).

const fs = require("fs");
const path = require("path");
const { getCheckedCertamenPayloadsPreview, filterPublishableCertamenPayloads } = require("./certamen-payload-validation");
const { persistAndScheduleCertamenIdeas } = require("./certamen-ideas-seed");
const { loginAgonAdminForCertamen } = require("./certamen-agon-admin-auth");

const AGON_URL = (process.env.AGON_URL || "http://localhost:3001").trim();
const SENT_TO_AGON_FILE = path.join(__dirname, "sent-to-agon.json");
const MAX_PUBLISH_SUBJECTS = 10;

// Identifiant fixe, non-admin, qui donne le visuel "arène communauté" sur Agôn
// (creator_key truthy et différent de AGON_ADMIN_CREATOR_KEY).
const CERTAMEN_CREATOR_KEY = process.env.CERTAMEN_CREATOR_KEY || "certamen-bot";

// POST /api/debates est limité à 5 requêtes / 60s par IP côté Agôn (rateLimit("debates", 5)).
const RATE_LIMIT_BATCH_SIZE = 5;
const RATE_LIMIT_WINDOW_PAUSE_MS = 61 * 1000;
const BETWEEN_CALLS_DELAY_MS = 1500;
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_RETRY_DELAY_MS = 15 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

// Best-effort, jamais bloquant : tente d'attacher les sources restantes (au-delà de la
// première) via l'endpoint admin media-extras. Sans AGON_ADMIN_PASSWORD ou en cas
// d'échec, le débat reste publié avec un seul source_url — aucune conséquence sur le
// visuel communauté (ce champ ne touche pas creator_key).
async function tryAttachExtraSources(debateId, links) {
  if (!Array.isArray(links) || links.length < 2) return;

  const adminHeaders = await loginAgonAdminForCertamen("certamen-publish");
  if (!adminHeaders) return;

  try {
    const extras = links
      .map((l) => ({ type: "source", url: String(l?.url || "").trim() }))
      .filter((l) => l.url);

    const r = await fetch(`${AGON_URL}/api/admin/debate/${debateId}/media-extras`, {
      method: "PUT",
      headers: adminHeaders,
      body: JSON.stringify({ media_extras: extras })
    });
    if (!r.ok) {
      console.warn(`[certamen-publish] Sources additionnelles non attachées pour le débat ${debateId} (statut ${r.status})`);
    }
  } catch (err) {
    console.warn(`[certamen-publish] Erreur attachement sources additionnelles pour le débat ${debateId} :`, err.message);
  }
}

async function publishOnePayloadToAgon(payload) {
  const isLibre = payload.arenaMode === "libre";
  const firstSourceUrl = Array.isArray(payload.links) && payload.links[0]?.url ? payload.links[0].url : "";

  const body = {
    question: payload.question,
    category: payload.theme || "",
    content: payload.resume || "",
    type: isLibre ? "open" : "debate",
    option_a: isLibre ? "" : (payload.positionA || ""),
    option_b: isLibre ? "" : (payload.positionB || ""),
    source_url: firstSourceUrl,
    creatorKey: CERTAMEN_CREATOR_KEY
    // Pas de storySelection : ce champ n'existe pas sur /api/debates, donc aucune
    // bulle actu ne peut être créée par cet appel, par construction.
  };

  for (let attempt = 1; attempt <= 1 + RATE_LIMIT_RETRIES; attempt += 1) {
    const r = await fetch(`${AGON_URL}/api/debates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    if (r.status === 429 && attempt <= RATE_LIMIT_RETRIES) {
      console.warn(`[certamen-publish] Rate-limit Agôn (429), nouvelle tentative dans ${RATE_LIMIT_RETRY_DELAY_MS / 1000}s pour "${String(payload.subject || "").slice(0, 60)}"`);
      await sleep(RATE_LIMIT_RETRY_DELAY_MS);
      continue;
    }

    if (!r.ok) {
      const errBody = await r.text().catch(() => "");
      throw new Error(`Agôn a répondu ${r.status}: ${errBody}`);
    }

    return r.json().catch(() => ({}));
  }

  throw new Error("Échec après nouvelles tentatives (rate-limit persistant)");
}

async function publishReadyCertamenPayloadsToAgon(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? Math.min(options.limit, MAX_PUBLISH_SUBJECTS)
    : MAX_PUBLISH_SUBJECTS;
  const preview = getCheckedCertamenPayloadsPreview();
  const readyPayloads = filterPublishableCertamenPayloads(preview.items).slice(0, limit);

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

  // Mêmes idées IA + voix + notification que la veille mixte, déclenchées 10 minutes
  // après chaque publication réussie (cf. certamen-ideas-seed.js).
  const ideasEntries = [];

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

    if (i > 0) {
      // Reste sous la limite Agôn de 5 requêtes/60s sur /api/debates : pause longue
      // toutes les 5 publications, pause courte sinon.
      await sleep(i % RATE_LIMIT_BATCH_SIZE === 0 ? RATE_LIMIT_WINDOW_PAUSE_MS : BETWEEN_CALLS_DELAY_MS);
    }

    try {
      const data = await publishOnePayloadToAgon(payload);
      const debateId = data.id || data.debateId || null;
      console.log(`[certamen-publish] ✓ Publié (arène communauté) : "${String(payload.subject || "").slice(0, 60)}" (debateId=${debateId || "?"})`);

      if (debateId) {
        await tryAttachExtraSources(debateId, payload.links);
      }

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
        creatorKey: CERTAMEN_CREATOR_KEY,
        debateId,
        sentAt: new Date().toISOString()
      });

      result.publishedCount += 1;
      result.results.push({ subject: payload.subject, ok: true, debateId });

      if (debateId) {
        ideasEntries.push({
          debateId,
          question: payload.question,
          positionA: payload.arenaMode === "libre" ? "" : (payload.positionA || ""),
          positionB: payload.arenaMode === "libre" ? "" : (payload.positionB || "")
        });
      }
    } catch (err) {
      console.error(`[certamen-publish] Erreur pour "${String(payload.subject || "").slice(0, 60)}" :`, err.message);
      result.results.push({ subject: payload.subject, ok: false, error: err.message });
    }
  }

  if (ideasEntries.length) {
    console.log(`[certamen-publish] Idées IA + voix programmées dans 10 minutes pour ${ideasEntries.length} arène(s)`);
    persistAndScheduleCertamenIdeas(ideasEntries);
  }

  // Pas de notification push pour Certamen, contrairement à la veille mixte — demande
  // explicite : seules les idées + voix sont reproduites, pas le broadcast.

  return result;
}

// Pendant à usage unique de publishReadyCertamenPayloadsToAgon : utilisé par le bouton
// individuel ".agon-btn" et par "Tout générer" sur /certamen (cf. POST /certamen/send-to-agon
// dans server.js). storySelection est toujours forcé à null, même si le client en envoie
// un — Certamen ne crée jamais de bulle actu, quelle que soit l'origine de l'appel.
async function publishSingleCertamenPayloadToAgon(rawPayload) {
  const question = String(rawPayload.question || "").trim().slice(0, 110);
  if (!question) throw new Error("question manquante");

  const arenaMode = String(rawPayload.arenaMode || "").trim() === "libre" ? "libre" : "positions";
  const payload = {
    subject: rawPayload.subject || question,
    question,
    positionA: arenaMode === "libre" ? "" : String(rawPayload.positionA || "").trim().slice(0, 55),
    positionB: arenaMode === "libre" ? "" : String(rawPayload.positionB || "").trim().slice(0, 55),
    theme: rawPayload.theme || "",
    resume: rawPayload.resume || "",
    sources: rawPayload.sources || "",
    links: Array.isArray(rawPayload.links) ? rawPayload.links : [],
    storySelection: null,
    arenaMode
  };

  if (wasAlreadySentToAgon(payload.question)) {
    return { ok: true, skipped: true, reason: "already_sent" };
  }

  const data = await publishOnePayloadToAgon(payload);
  const debateId = data.id || data.debateId || null;

  if (debateId) {
    await tryAttachExtraSources(debateId, payload.links);
  }

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
    creatorKey: CERTAMEN_CREATOR_KEY,
    debateId,
    sentAt: new Date().toISOString()
  });

  if (debateId) {
    persistAndScheduleCertamenIdeas([{
      debateId,
      question: payload.question,
      positionA: payload.positionA,
      positionB: payload.positionB
    }]);
  }

  return { ok: true, debateId };
}

module.exports = {
  MAX_PUBLISH_SUBJECTS,
  CERTAMEN_CREATOR_KEY,
  publishReadyCertamenPayloadsToAgon,
  publishSingleCertamenPayloadToAgon
};
