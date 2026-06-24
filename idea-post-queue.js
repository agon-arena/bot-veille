// File d'attente partagée pour la génération/publication des idées IA.
//
// Pourquoi : la veille mixte (server.js) et Certamen (certamen-ideas-seed.js) tournent
// dans le même process et appellent toutes les deux POST /api/arguments sur Agôn depuis
// la même IP sortante. Si plusieurs débats lancent leur génération d'idées au même
// instant (ex: 11 arènes publiées en rafale puis programmées 10 min plus tard), les
// idées sont postées en parallèle sur Agôn et déclenchent son rate limit
// ("Trop de requêtes. Réessaie dans quelques instants.").
//
// Cette file garantit qu'un seul débat à la fois génère/poste ses idées (concurrence
// strictement limitée à 1), avec une pause aléatoire entre deux débats, quel que soit
// le pipeline d'origine (veille mixte ou Certamen) ou le moment où les jobs arrivent
// (planification initiale, reprise après redémarrage, retry...).

const INTER_DEBATE_DELAY_MIN_MS = 10 * 1000;
const INTER_DEBATE_DELAY_MAX_MS = 20 * 1000;

const queue = [];
let draining = false;

function randomInterDebateDelay() {
  return INTER_DEBATE_DELAY_MIN_MS + Math.floor(Math.random() * (INTER_DEBATE_DELAY_MAX_MS - INTER_DEBATE_DELAY_MIN_MS));
}

async function drain() {
  if (draining) return;
  draining = true;
  while (queue.length) {
    const { label, run, resolve, reject } = queue.shift();
    console.log(`[idees-ia-queue] Débat en cours : ${label} (${queue.length} en attente derrière)`);
    try {
      resolve(await run());
    } catch (err) {
      reject(err);
    }
    if (queue.length) {
      const delay = randomInterDebateDelay();
      console.log(`[idees-ia-queue] Pause de ${Math.round(delay / 1000)}s avant le prochain débat`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  draining = false;
}

// label : identifiant lisible (ex: id du débat) pour les logs.
// run   : fonction async à exécuter en exclusivité (un seul job actif à la fois).
function enqueueIdeaJob(label, run) {
  return new Promise((resolve, reject) => {
    queue.push({ label, run, resolve, reject });
    console.log(`[idees-ia-queue] Débat ajouté à la file : ${label} (position ${queue.length})`);
    drain();
  });
}

module.exports = { enqueueIdeaJob };
