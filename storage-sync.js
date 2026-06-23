const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const BUCKET = "json-data";
const SYNC_INTERVAL_MS = 30_000;

const FILES_TO_SYNC = [
  "seen-items.json",
  "sessions-veille.json",
  "sessions-mixte.json",
  "sessions-youtube.json",
  "saved-subjects.json",
  "sent-to-agon.json",
  "certamen-sessions.json",
  "veille-mixte.json",
  "veille-youtube.json",
  "auto-collect-config.json",
  "auto-collect-certamen-config.json",
  "auto-publish-config.json",
  "youtube-chaines.json",
  "medias.json",
  "pending-ideas.json",
];

let supabase = null;
let enabled = false;

function init() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log("[storage-sync] Variables SUPABASE_URL / SUPABASE_SECRET_KEY absentes — sync désactivé (mode local)");
    return;
  }
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  enabled = true;
  console.log("[storage-sync] Supabase connecté");
}

async function downloadAll() {
  if (!enabled) return;
  console.log("[storage-sync] Téléchargement des fichiers depuis Supabase...");
  for (const filename of FILES_TO_SYNC) {
    try {
      const { data, error } = await supabase.storage.from(BUCKET).download(filename);
      if (error) {
        // Fichier absent sur Supabase — on garde la version locale si elle existe
        continue;
      }
      const text = await data.text();
      const localPath = path.join(__dirname, filename);
      fs.writeFileSync(localPath, text, "utf8");
      console.log(`[storage-sync] ✓ ${filename}`);
    } catch (err) {
      console.warn(`[storage-sync] Erreur download ${filename}:`, err.message);
    }
  }
  console.log("[storage-sync] Téléchargement terminé");
}

async function uploadAll() {
  if (!enabled) return;
  for (const filename of FILES_TO_SYNC) {
    const localPath = path.join(__dirname, filename);
    if (!fs.existsSync(localPath)) continue;
    try {
      const content = fs.readFileSync(localPath, "utf8");
      const { error } = await supabase.storage.from(BUCKET).upload(filename, content, {
        contentType: "application/json",
        upsert: true,
      });
      if (error) console.warn(`[storage-sync] Erreur upload ${filename}:`, error.message);
    } catch (err) {
      console.warn(`[storage-sync] Erreur upload ${filename}:`, err.message);
    }
  }
}

function startPeriodicSync() {
  if (!enabled) return;
  setInterval(async () => {
    await uploadAll();
  }, SYNC_INTERVAL_MS);
  console.log(`[storage-sync] Sync automatique toutes les ${SYNC_INTERVAL_MS / 1000}s`);
}

module.exports = { init, downloadAll, startPeriodicSync };
