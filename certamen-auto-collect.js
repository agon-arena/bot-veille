// Auto-collecte Certamen : planification horaire dédiée, indépendante de l'auto-collecte
// veille mixte (AUTO_COLLECT_FILE / scheduleAutoCollect dans server.js). Déclenche
// uniquement POST http://127.0.0.1:3002/certamen/refresh — ne touche ni aux bulles actu,
// ni à la génération d'article. L'envoi vers Agôn n'est jamais décidé ici : ce module
// expose juste un hook optionnel (onAfterRefresh), appelé une fois la collecte lancée ;
// c'est server.js qui décide d'attendre la fin et de publier, selon auto-publish-certamen-config.json.

const fs = require("fs");
const path = require("path");

const AUTO_COLLECT_CERTAMEN_FILE = path.join(__dirname, "auto-collect-certamen-config.json");

// Indian/Reunion est à UTC+4 toute l'année (pas d'heure d'été), même calcul que
// l'auto-collecte veille mixte existante.
const REUNION_UTC_OFFSET_HOURS = 4;

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6]; // 0 = dimanche, comme Date#getUTCDay()

let certamenAutoCollectTimers = [];

// Ancien format ({ times: ["08:00"] }) : chaque heure tournait tous les jours.
// Migré à la volée en { entries: [{ time, days }] } pour permettre de restreindre
// à certains jours de la semaine sans casser les configs déjà enregistrées.
function migrateAutoCollectCertamenConfig(config) {
  if (Array.isArray(config.entries)) return config;
  const times = Array.isArray(config.times) && config.times.length ? config.times : ["08:00"];
  return { enabled: !!config.enabled, entries: times.map((t) => ({ time: t, days: ALL_DAYS.slice() })) };
}

function loadAutoCollectCertamenConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTO_COLLECT_CERTAMEN_FILE, "utf8"));
    return migrateAutoCollectCertamenConfig(raw);
  } catch {
    return { enabled: false, entries: [{ time: "08:00", days: ALL_DAYS.slice() }] };
  }
}

function saveAutoCollectCertamenConfig(config) {
  fs.writeFileSync(AUTO_COLLECT_CERTAMEN_FILE, JSON.stringify(config, null, 2), "utf8");
}

// Prochaine occurrence de h:m heure de la Réunion parmi les jours autorisés, indépendamment
// du fuseau horaire local du process (ex: UTC sur Render).
function nextAutoCollectCertamenInstant(timeStr, days, now) {
  const [h, m] = timeStr.split(":").map(Number);
  const reunionNow = new Date(now.getTime() + REUNION_UTC_OFFSET_HOURS * 60 * 60 * 1000);
  const y = reunionNow.getUTCFullYear(), mo = reunionNow.getUTCMonth(), d = reunionNow.getUTCDate();
  for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
    const weekday = new Date(Date.UTC(y, mo, d + dayOffset)).getUTCDay();
    if (!days.includes(weekday)) continue;
    const candidate = new Date(Date.UTC(y, mo, d + dayOffset, h - REUNION_UTC_OFFSET_HOURS, m, 0, 0));
    // Marge de 60s : setTimeout peut sonner quelques ms avant l'heure cible. Sans marge,
    // la reprogrammation retombe sur la même occurrence et déclenche une seconde collecte
    // immédiate (double-run du 05/07/2026 : deux auto-publish simultanés → arènes 1377/1378
    // en doublon sur Agôn).
    if (candidate.getTime() - now.getTime() >= 60 * 1000) return candidate;
  }
  // Filet de sécurité si `days` est vide ou mal formé : ne devrait pas arriver, config validée en amont.
  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}

function scheduleOneAutoCollectCertamen(entry, onAfterRefresh) {
  const { time: timeStr, days } = entry;
  const now = new Date();
  const next = nextAutoCollectCertamenInstant(timeStr, days, now);
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
          if (typeof onAfterRefresh === "function") onAfterRefresh();
        } else {
          const body = await r.text().catch(() => "");
          console.error(`[auto-collect-certamen] POST /certamen/refresh a échoué (${r.status}) : ${body}`);
        }
      } catch (err) {
        console.error(`[auto-collect-certamen] Erreur : ${err.message}`);
      }
      scheduleOneAutoCollectCertamen(entry, onAfterRefresh);
    }
  }, delay);

  certamenAutoCollectTimers.push(timer);
  const nextDate = new Date(Date.now() + delay);
  console.log(`[auto-collect-certamen] Heure programmée ${timeStr} (jours ${days.join(",")}) → prochaine collecte le ${nextDate.toLocaleDateString("fr-FR")} à ${nextDate.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`);
}

function scheduleAutoCollectCertamen(config, onAfterRefresh) {
  certamenAutoCollectTimers.forEach((t) => clearTimeout(t));
  certamenAutoCollectTimers = [];
  const cfg = migrateAutoCollectCertamenConfig(config);
  if (!cfg.enabled || !Array.isArray(cfg.entries) || !cfg.entries.length) {
    console.log("[auto-collect-certamen] Auto-collecte Certamen désactivée.");
    return;
  }
  cfg.entries.forEach((entry) => scheduleOneAutoCollectCertamen(entry, onAfterRefresh));
}

module.exports = {
  AUTO_COLLECT_CERTAMEN_FILE,
  loadAutoCollectCertamenConfig,
  saveAutoCollectCertamenConfig,
  scheduleAutoCollectCertamen
};
