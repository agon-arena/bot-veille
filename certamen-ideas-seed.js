// Reproduit pour Certamen, à l'identique, le seeding post-publication déjà utilisé par
// le pipeline veille mixte (server.js : generateAndPostIdeas / persistAndScheduleIdeas /
// broadcast-daily) : idées IA simulées, voix (votes) initiales, notification push.
// Persistance séparée (certamen-pending-ideas.json) pour ne jamais mélanger avec le
// pending-ideas.json de la veille mixte.

const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { AGON_URL, loginAgonAdminForCertamen } = require("./certamen-agon-admin-auth");
const { enqueueIdeaJob } = require("./idea-post-queue");

const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

const PENDING_IDEAS_FILE = path.join(__dirname, "certamen-pending-ideas.json");
const IDEAS_DELAY_MS = 10 * 60 * 1000; // même délai que la veille mixte
const MAX_IDEA_ATTEMPTS = 3;
const IDEA_RETRY_DELAY_MS = 5 * 60 * 1000;

// Retry ciblé sur une idée précise (jamais re-générée, jamais republiée si elle est
// déjà passée) quand Agôn répond "Trop de requêtes" — évite d'abandonner toute la
// série pour un seul échec de rythme. Identique à la veille mixte (server.js).
const IDEA_POST_MAX_ATTEMPTS = 3;
const IDEA_POST_RATE_LIMIT_WAIT_MS = 15000;

function loadPendingIdeas() {
  try {
    return JSON.parse(fs.readFileSync(PENDING_IDEAS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function savePendingIdeas(items) {
  fs.writeFileSync(PENDING_IDEAS_FILE, JSON.stringify(items, null, 2), "utf8");
}

function buildCurrentDateContext() {
  const currentDateLabel = new Date().toLocaleDateString("fr-FR", { timeZone: "Indian/Reunion", year: "numeric", month: "long", day: "numeric" });
  return `Date actuelle : ${currentDateLabel}. Nous sommes en ${new Date().getFullYear()}. N'évoque jamais une autre année comme si elle était récente ou actuelle (ta connaissance s'arrête avant cette date, mais le contexte ci-dessus est réel et à jour).`;
}

// Identique à generateAndPostIdeas() de server.js (même prompt, mêmes règles de
// répartition camp A/B et de plage de voix) — seule la persistance/planification autour
// est dupliquée dans ce module dédié Certamen.
async function generateAndPostCertamenIdeas(debateId, question, positionA, positionB, adminHeaders) {
  if (!openai) { console.warn("[certamen-idées-ia] OPENAI_API_KEY absent"); return false; }
  console.log(`[certamen-idées-ia] Débat ${debateId} — début génération des idées`);
  const isPositions = !!(positionA && positionB);
  const N = Math.floor(Math.random() * 3) + 7;

  const dateContext = buildCurrentDateContext();

  const styleInstructions = `
Consignes de style (OBLIGATOIRES) :
- RÈGLE ABSOLUE, valable pour TOUTES les idées sans exception : zéro ton d'IA. Interdits formels : "d'une part... d'autre part", "il est important de noter que", "en somme/en conclusion/pour conclure", "il convient de", "cela soulève la question de", toute phrase d'équilibrage qui valide les deux côtés à la fin, tout vocabulaire de dissertation scolaire. Personne n'écrit comme ça sur un réseau de débat. Chaque idée doit sonner comme un vrai message tapé par une vraie personne, avec ses tics propres.
- ${N - 4} idées doivent sembler écrites par des gens ordinaires, superficiels ou provocateurs : raisonnements approximatifs, raccourcis, opinions tranchées sans nuance, ton varié (agacés, naïfs, arrogants). Introduis des fautes d'orthographe et de frappe naturelles sur ces idées (ex: "sa" pour "ça", "j'ais", "voire" pour "voir", mots collés, etc.). Marque ces idées : "qualite": "mauvaise".
- 2 idées doivent être correctement écrites et plutôt sensées, mais sans plus : un avis simple, parfois un peu court ou pas totalement abouti, sans faute grossière mais pas littéraire non plus. Ça reste écrit à la manière de quelqu'un de normal, pas d'un assistant. Marque ces idées : "qualite": "moyenne".
- 2 idées doivent être bien écrites et bien raisonnées, sans fautes, mais TRANCHANTES : une position claire et affirmée, défendue avec un ou deux arguments concrets, pas un avis mou qui pèse le pour et le contre. Ça doit sonner comme une personne informée qui a un avis tranché et le dit cash, pas comme une copie bien sage. Varie le ton et la formulation d'une idée à l'autre (sec, mordant, énervé-mais-argumenté, froidement ironique...). Marque ces idées : "qualite": "bonne".`;

  const prompt = isPositions
    ? `Tu es un simulateur de commentaires citoyens sur un réseau de débat. Génère exactement ${N} idées pour alimenter ce débat.

${dateContext}

Question : ${question}
Camp A : ${positionA}
Camp B : ${positionB}

Répartis les idées : 4 pour le camp A et 3 pour le camp B (ou 3 pour A et 4 pour B, varie aléatoirement).
${styleInstructions}

Réponds en JSON : { "ideas": [ { "side": "A" ou "B", "qualite": "bonne" ou "moyenne" ou "mauvaise", "title": "...", "body": "..." }, ... ] }
- title : 1 phrase courte (max 120 caractères)
- body : longueur variable (mauvaises idées : 30-150 car. ; idées moyennes : 100-300 car. ; bonnes idées : 200-550 car.), peut être vide si l'idée se suffit`
    : `Tu es un simulateur de commentaires citoyens sur un réseau de débat. Génère exactement ${N} idées sur ce sujet.

${dateContext}

Sujet : ${question}
${styleInstructions}

Réponds en JSON : { "ideas": [ { "qualite": "bonne" ou "moyenne" ou "mauvaise", "title": "...", "body": "..." }, ... ] }
- title : 1 phrase courte (max 120 caractères)
- body : longueur variable (mauvaises idées : 30-150 car. ; idées moyennes : 100-300 car. ; bonnes idées : 200-550 car.), peut être vide`;

  let ideas;
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 1.1,
      max_tokens: 2500
    });
    const parsed = JSON.parse(response.choices[0].message.content);
    ideas = parsed.ideas;
    if (!Array.isArray(ideas) || !ideas.length) throw new Error("Format invalide");
  } catch (err) {
    console.error("[certamen-idées-ia] Erreur génération :", err.message);
    return false;
  }

  console.log(`[certamen-idées-ia] Débat ${debateId} — ${ideas.length} idée(s) générée(s), publication séquentielle...`);

  for (let i = 0; i < ideas.length; i++) {
    const idea = ideas[i];
    const authorKey = Math.random().toString(36).slice(2, 14);
    console.log(`[certamen-idées-ia] Débat ${debateId} — idée ${i + 1}/${ideas.length} : envoi...`);

    let posted = false;
    for (let attempt = 1; attempt <= IDEA_POST_MAX_ATTEMPTS && !posted; attempt++) {
      try {
        const r = await fetch(`${AGON_URL}/api/arguments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            debate_id: debateId,
            side: isPositions ? (idea.side || "A") : (Math.random() < 0.5 ? "A" : "B"),
            title: String(idea.title || "").slice(0, 180),
            body: String(idea.body || "").slice(0, 2500),
            authorKey
          })
        });
        if (r.ok) {
          posted = true;
          const { id: argId } = await r.json().catch(() => ({}));
          const isMauvaise = idea.qualite === "mauvaise";
          const votes = isMauvaise
            ? Math.floor(Math.random() * 14) + 3
            : Math.floor(Math.random() * 23) + 17;
          console.log(`[certamen-idées-ia] ✓ Débat ${debateId} — idée ${i + 1}/${ideas.length} publiée (${idea.qualite || "mauvaise"}, camp ${idea.side || "libre"}) → ${votes} voix`);
          if (argId && adminHeaders) {
            await fetch(`${AGON_URL}/api/admin/argument/${argId}/set-votes`, {
              method: "POST",
              headers: adminHeaders,
              body: JSON.stringify({ votes })
            }).catch(() => {});
          }
        } else {
          const txt = await r.text().catch(() => "");
          const isRateLimited = /trop de requ[êe]tes/i.test(txt);
          if (isRateLimited && attempt < IDEA_POST_MAX_ATTEMPTS) {
            console.warn(`[certamen-idées-ia] Débat ${debateId} — idée ${i + 1}/${ideas.length} : rate-limit Agôn, attente ${IDEA_POST_RATE_LIMIT_WAIT_MS / 1000}s avant nouvelle tentative (${attempt}/${IDEA_POST_MAX_ATTEMPTS})`);
            await new Promise((res) => setTimeout(res, IDEA_POST_RATE_LIMIT_WAIT_MS));
          } else {
            console.warn(`[certamen-idées-ia] Débat ${debateId} — idée ${i + 1}/${ideas.length} : échec (tentative ${attempt}/${IDEA_POST_MAX_ATTEMPTS}) :`, txt);
            break;
          }
        }
      } catch (err) {
        console.warn(`[certamen-idées-ia] Débat ${debateId} — idée ${i + 1}/${ideas.length} : erreur réseau (tentative ${attempt}/${IDEA_POST_MAX_ATTEMPTS}) :`, err.message);
        if (attempt < IDEA_POST_MAX_ATTEMPTS) {
          await new Promise((res) => setTimeout(res, IDEA_POST_RATE_LIMIT_WAIT_MS));
        }
      }
    }
    if (!posted) {
      console.error(`[certamen-idées-ia] Débat ${debateId} — idée ${i + 1}/${ideas.length} : abandon après ${IDEA_POST_MAX_ATTEMPTS} tentatives, passage à la suivante`);
    }

    await new Promise((r) => setTimeout(r, 7000));
  }
  console.log(`[certamen-idées-ia] Débat ${debateId} — génération des idées terminée`);
  return true;
}

function scheduleOneCertamenPendingIdea(item) {
  const delay = Math.max(0, new Date(item.runAt).getTime() - Date.now());
  setTimeout(async () => {
    const items = loadPendingIdeas();
    const match = items.find((i) => i.id === item.id && i.status === "pending");
    if (!match) return;

    let success = false;
    try {
      success = await enqueueIdeaJob(match.debateId, async () => {
        const adminHeaders = await loginAgonAdminForCertamen("certamen-idées-ia");
        return generateAndPostCertamenIdeas(match.debateId, match.question, match.positionA, match.positionB, adminHeaders);
      });
    } catch (err) {
      console.error("[certamen-idées-ia] Erreur reprise idée :", err.message);
    }

    const itemsAfter = loadPendingIdeas();
    const matchAfter = itemsAfter.find((i) => i.id === item.id);
    if (!matchAfter) return;

    if (success) {
      matchAfter.status = "done";
      savePendingIdeas(itemsAfter);
      return;
    }

    matchAfter.attempts = (matchAfter.attempts || 0) + 1;
    if (matchAfter.attempts >= MAX_IDEA_ATTEMPTS) {
      matchAfter.status = "failed";
      savePendingIdeas(itemsAfter);
      console.error(`[certamen-idées-ia] Abandon après ${matchAfter.attempts} tentative(s) pour débat ${match.debateId}`);
      return;
    }

    matchAfter.runAt = new Date(Date.now() + IDEA_RETRY_DELAY_MS).toISOString();
    savePendingIdeas(itemsAfter);
    console.warn(`[certamen-idées-ia] Échec, nouvelle tentative (${matchAfter.attempts}/${MAX_IDEA_ATTEMPTS}) dans 5 min pour débat ${match.debateId}`);
    scheduleOneCertamenPendingIdea(matchAfter);
  }, delay);
}

// entries : [{ debateId, question, positionA, positionB }]
function persistAndScheduleCertamenIdeas(entries, delayMs = IDEAS_DELAY_MS) {
  if (!Array.isArray(entries) || !entries.length) return;
  const runAt = new Date(Date.now() + delayMs).toISOString();
  const items = loadPendingIdeas();
  for (const entry of entries) {
    const item = { ...entry, id: `${entry.debateId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, runAt, status: "pending", attempts: 0 };
    items.push(item);
    scheduleOneCertamenPendingIdea(item);
  }
  savePendingIdeas(items);
}

// À appeler au démarrage du serveur (cf. server.js), comme resumePendingIdeasOnStartup()
// pour la veille mixte : reprend les idées Certamen non générées après un redémarrage.
function resumeCertamenPendingIdeasOnStartup() {
  const items = loadPendingIdeas();
  const pending = items.filter((i) => i.status === "pending");
  if (pending.length) {
    console.log(`[certamen-idées-ia] Reprise de ${pending.length} idée(s) en attente après redémarrage`);
    pending.forEach(scheduleOneCertamenPendingIdea);
  }
}

module.exports = {
  persistAndScheduleCertamenIdeas,
  resumeCertamenPendingIdeasOnStartup
};
