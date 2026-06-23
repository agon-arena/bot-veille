// Auto-collecte Certamen : planification horaire dédiée, indépendante de l'auto-collecte
// veille mixte (AUTO_COLLECT_FILE / scheduleAutoCollect dans server.js). Déclenche
// uniquement POST http://127.0.0.1:3002/certamen/refresh — ne touche ni à l'envoi vers
// Agôn, ni aux bulles actu, ni à la génération d'article.

const fs = require("fs");
const path = require("path");

const AUTO_COLLECT_CERTAMEN_FILE = path.join(__dirname, "auto-collect-certamen-config.json");

// Indian/Reunion est à UTC+4 toute l'année (pas d'heure d'été), même calcul que
// l'auto-collecte veille mixte existante.
const REUNION_UTC_OFFSET_HOURS = 4;

let certamenAutoCollectTimers = [];

function loadAutoCollectCertamenConfig() {
  try {
    return JSON.parse(fs.readFileSync(AUTO_COLLECT_CERTAMEN_FILE, "utf8"));
  } catch {
    return { enabled: false, times: ["08:00"] };
  }
}

function saveAutoCollectCertamenConfig(config) {
  fs.writeFileSync(AUTO_COLLECT_CERTAMEN_FILE, JSON.stringify(config, null, 2), "utf8");
}

function scheduleOneAutoCollectCertamen(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  const now = new Date();
  // Calcule la prochaine occurrence de h:m heure de la Réunion, indépendamment
  // du fuseau horaire local du process (ex: UTC sur Render).
  let next = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    h - REUNION_UTC_OFFSET_HOURS, m, 0, 0
  ));
  while (next <= now) next = new Date(next.getTime() + 24 * 60 * 60 * 1000);
  const delay = next - now;

  const timer = setTimeout(async () => {
    certamenAutoCollectTimers = certamenAutoCollectTimers.filter((t) => t !== timer);
    console.log(`[auto-collect-certamen] Déclenchement à ${timeStr}`);
    const cfg = loadAutoCollectCertamenConfig();
    if (cfg.enabled) {
      try {
        const r = await fetch("http://127.0.0.1:3002/certamen/refresh", { method: "POST" });
        if (r.ok) {
          const body = await r.json().catch(() => ({}));
          console.log(`[auto-collect-certamen] POST /certamen/refresh : succès (${body.running ? "déjà en cours" : "démarré"})`);
        } else {
          const body = await r.text().catch(() => "");
          console.error(`[auto-collect-certamen] POST /certamen/refresh a échoué (${r.status}) : ${body}`);
        }
      } catch (err) {
        console.error(`[auto-collect-certamen] Erreur : ${err.message}`);
      }
      scheduleOneAutoCollectCertamen(timeStr);
    }
  }, delay);

  certamenAutoCollectTimers.push(timer);
  const nextDate = new Date(Date.now() + delay);
  console.log(`[auto-collect-certamen] Heure programmée ${timeStr} → prochaine collecte le ${nextDate.toLocaleDateString("fr-FR")} à ${nextDate.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`);
}

function scheduleAutoCollectCertamen(config) {
  certamenAutoCollectTimers.forEach((t) => clearTimeout(t));
  certamenAutoCollectTimers = [];
  if (!config.enabled || !Array.isArray(config.times) || !config.times.length) {
    console.log("[auto-collect-certamen] Auto-collecte Certamen désactivée.");
    return;
  }
  config.times.forEach((t) => scheduleOneAutoCollectCertamen(t));
}

module.exports = {
  AUTO_COLLECT_CERTAMEN_FILE,
  loadAutoCollectCertamenConfig,
  saveAutoCollectCertamenConfig,
  scheduleAutoCollectCertamen
};
