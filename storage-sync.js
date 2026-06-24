const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const BUCKET = "json-data";
// Sync périodique espacée (au lieu de 30s) : la collecte RSS/YouTube est gérée par
// un scheduler totalement séparé (cf. scheduleAutoCollect / auto-collect-config.json),
// ce délai ne concerne que la sauvegarde des fichiers JSON vers Supabase.
const SYNC_INTERVAL_MS = 5 * 60_000; // 5 minutes

const FILES_TO_SYNC = [
  "seen-items.json",
  "sessions-veille.json",
  "sessions-mixte.json",
  "saved-subjects.json",
  "sent-to-agon.json",
  "certamen-sessions.json",
  "veille-mixte.json",
  "auto-collect-config.json",
  "auto-collect-certamen-config.json",
  "auto-publish-config.json",
  "auto-publish-certamen-config.json",
  "youtube-chaines.json",
  "medias.json",
  "pending-ideas.json",
  "certamen-pending-ideas.json",
];

const STATE_FILE = path.join(__dirname, "storage-sync-state.json");

let supabase = null;
let enabled = false;
// Protège uploadAll() : ne doit jamais s'exécuter avant la fin de la vérification
// faite par downloadAll(), sous peine d'écraser Supabase avec des fichiers locaux
// potentiellement obsolètes (ex: juste après un redéploiement Render).
let downloadCompleted = false;

function init() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log("[storage-sync] Variables SUPABASE_URL / SUPABASE_SECRET_KEY absentes — sync désactivé (mode local)");
    return;
  }
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
  enabled = true;
  console.log("[storage-sync] Supabase connecté");
}

function isLocalFilePresentAndNonEmpty(localPath) {
  try {
    if (!fs.existsSync(localPath)) return false;
    const stats = fs.statSync(localPath);
    return stats.size > 0;
  } catch (err) {
    return false;
  }
}

// État local : pour chaque fichier, le `updated_at` Supabase avec lequel le fichier
// local était en phase lors de la dernière synchro réussie (download ou upload).
// Ce fichier n'est ni uploadé ni téléchargé : c'est une mémoire purement locale au
// conteneur, qui redevient naturellement vide après un redéploiement Render (le
// disque est neuf) — ce qui force alors un téléchargement complet et sûr depuis
// Supabase plutôt que de faire confiance à des fichiers locaux issus du dépôt Git.
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch (err) {
    console.warn("[storage-sync] État local illisible, on repart d'un état vide:", err.message);
    return {};
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    console.warn("[storage-sync] Impossible d'écrire l'état local:", err.message);
  }
}

function hashContent(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

// Met à jour state[filename] en ne touchant que les champs fournis, pour ne jamais
// perdre le `hash` (utilisé par uploadAll) en mettant juste à jour `updatedAt`, ou
// l'inverse.
function setFileState(state, filename, { updatedAt, hash } = {}) {
  const prev = state[filename] || {};
  state[filename] = {
    updatedAt: updatedAt !== undefined ? updatedAt : prev.updatedAt,
    hash: hash !== undefined ? hash : prev.hash,
  };
}

// Récupère uniquement les métadonnées des fichiers du bucket (dont `updated_at`),
// sans télécharger leur contenu — coût d'egress négligeable comparé à download().
async function fetchRemoteList() {
  try {
    const { data, error } = await supabase.storage.from(BUCKET).list("", { limit: 1000 });
    if (error) {
      console.warn("[storage-sync] Erreur list() Supabase:", error.message);
      return null;
    }
    const map = {};
    for (const entry of data || []) {
      map[entry.name] = entry;
    }
    return map;
  } catch (err) {
    console.warn("[storage-sync] Erreur list() Supabase:", err.message);
    return null;
  }
}

async function downloadFile(filename, localPath) {
  const { data, error } = await supabase.storage.from(BUCKET).download(filename);
  if (error) throw new Error(error.message);
  const text = await data.text();
  fs.writeFileSync(localPath, text, "utf8");
  return text;
}

async function downloadAll() {
  if (!enabled) {
    downloadCompleted = true;
    return;
  }

  const forceDownload = process.env.FORCE_SUPABASE_DOWNLOAD === "true";
  console.log(
    `[storage-sync] Démarrage downloadAll() — mode: ${forceDownload ? "FORCE_SUPABASE_DOWNLOAD (tout retélécharger)" : "normal (comparaison local/Supabase)"}`
  );

  const state = forceDownload ? {} : loadState();
  // En mode force, on ignore la liste distante : on retélécharge tout sans condition,
  // exactement comme l'ancien comportement.
  const remoteMap = forceDownload ? null : await fetchRemoteList();
  const remoteListFailed = !forceDownload && remoteMap === null;
  if (remoteListFailed) {
    console.warn(
      "[storage-sync] Impossible de lister le bucket Supabase — par sécurité, on revérifie chaque fichier individuellement plutôt que de faire confiance à l'état local."
    );
  }

  const keptUpToDate = [];
  const downloadedMissingOrEmpty = [];
  const downloadedNewerOrUnknown = [];
  const missingRemote = [];
  const errored = [];

  for (const filename of FILES_TO_SYNC) {
    const localPath = path.join(__dirname, filename);
    const localPresent = isLocalFilePresentAndNonEmpty(localPath);
    const remoteEntry = remoteMap ? remoteMap[filename] : undefined;

    try {
      if (forceDownload) {
        const text = await downloadFile(filename, localPath);
        setFileState(state, filename, { updatedAt: remoteEntry?.updated_at, hash: hashContent(text) });
        downloadedNewerOrUnknown.push(filename);
        continue;
      }

      if (!localPresent) {
        if (remoteListFailed || remoteEntry) {
          const text = await downloadFile(filename, localPath);
          // remoteMap absent (list échouée) -> on ne connaît pas updated_at, l'état
          // restera "inconnu" jusqu'à la prochaine liste réussie : comportement sûr.
          setFileState(state, filename, { updatedAt: remoteEntry?.updated_at, hash: hashContent(text) });
          downloadedMissingOrEmpty.push(filename);
        } else {
          missingRemote.push(filename);
        }
        continue;
      }

      // Fichier local présent : on ne le garde QUE si on peut prouver qu'il est à
      // jour par rapport à Supabase. Sans preuve (liste échouée, jamais synchronisé,
      // ou Supabase modifié depuis), on retélécharge plutôt que de risquer un upload
      // ultérieur qui écraserait une donnée plus récente côté Supabase.
      if (remoteListFailed) {
        const text = await downloadFile(filename, localPath);
        setFileState(state, filename, { hash: hashContent(text) });
        downloadedNewerOrUnknown.push(filename);
        continue;
      }

      if (!remoteEntry) {
        missingRemote.push(filename);
        continue;
      }

      const lastSynced = state[filename]?.updatedAt;
      if (lastSynced && lastSynced === remoteEntry.updated_at) {
        keptUpToDate.push(filename);
        continue;
      }

      const text = await downloadFile(filename, localPath);
      setFileState(state, filename, { updatedAt: remoteEntry.updated_at, hash: hashContent(text) });
      downloadedNewerOrUnknown.push(filename);
    } catch (err) {
      errored.push(filename);
      console.warn(`[storage-sync] Erreur download ${filename}:`, err.message);
    }
  }

  saveState(state);

  if (keptUpToDate.length) {
    console.log(`[storage-sync] Conservés localement, déjà à jour (${keptUpToDate.length}): ${keptUpToDate.join(", ")}`);
  }
  if (downloadedMissingOrEmpty.length) {
    console.log(`[storage-sync] Téléchargés (absents/vides en local) (${downloadedMissingOrEmpty.length}): ${downloadedMissingOrEmpty.join(", ")}`);
  }
  if (downloadedNewerOrUnknown.length) {
    console.log(`[storage-sync] Téléchargés (Supabase plus récent ou état local inconnu) (${downloadedNewerOrUnknown.length}): ${downloadedNewerOrUnknown.join(", ")}`);
  }
  if (missingRemote.length) {
    console.log(`[storage-sync] Absents côté Supabase, fallback local (${missingRemote.length}): ${missingRemote.join(", ")}`);
  }
  if (errored.length) {
    console.warn(`[storage-sync] Erreurs de téléchargement (${errored.length}): ${errored.join(", ")}`);
  }
  console.log("[storage-sync] downloadAll() terminé");

  downloadCompleted = true;
}

async function uploadAll() {
  if (!enabled) return;
  if (!downloadCompleted) {
    console.warn("[storage-sync] uploadAll() ignoré : downloadAll() n'est pas encore terminé (protection anti-écrasement).");
    return;
  }

  const state = loadState();
  const uploaded = [];
  const unchanged = [];

  for (const filename of FILES_TO_SYNC) {
    const localPath = path.join(__dirname, filename);
    if (!fs.existsSync(localPath)) continue;
    try {
      const content = fs.readFileSync(localPath, "utf8");
      const hash = hashContent(content);
      // Pas de changement local depuis le dernier sync (download ou upload) :
      // on évite un appel Supabase inutile.
      const prevHash = state[filename]?.hash;
      if (prevHash && prevHash === hash) {
        unchanged.push(filename);
        continue;
      }

      const { error } = await supabase.storage.from(BUCKET).upload(filename, content, {
        contentType: "application/json",
        cacheControl: "0",
        upsert: true,
      });
      if (error) {
        console.warn(`[storage-sync] Erreur upload ${filename}:`, error.message);
      } else {
        uploaded.push(filename);
        setFileState(state, filename, { hash });
      }
    } catch (err) {
      console.warn(`[storage-sync] Erreur upload ${filename}:`, err.message);
    }
  }

  // Met à jour l'état local pour que les prochains démarrages (dans le même
  // conteneur) sachent que ces fichiers sont désormais à jour avec Supabase,
  // sans avoir besoin de les retélécharger.
  if (uploaded.length) {
    const remoteMap = await fetchRemoteList();
    if (remoteMap) {
      for (const filename of uploaded) {
        if (remoteMap[filename]) setFileState(state, filename, { updatedAt: remoteMap[filename].updated_at });
      }
    }
  }
  saveState(state);

  if (uploaded.length) {
    console.log(
      `[storage-sync] Sync : ${uploaded.length} fichier(s) modifié(s) envoyé(s) vers Supabase (${uploaded.join(", ")}), ${unchanged.length} inchangé(s) (non transmis).`
    );
  } else {
    console.log(`[storage-sync] Sync : aucun changement local depuis le dernier envoi (${unchanged.length} fichier(s) inchangé(s)), rien à transmettre à Supabase.`);
  }
}

function startPeriodicSync() {
  if (!enabled) return;
  setInterval(async () => {
    await uploadAll();
  }, SYNC_INTERVAL_MS);
  console.log(
    `[storage-sync] Sync automatique toutes les ${SYNC_INTERVAL_MS / 1000}s (${SYNC_INTERVAL_MS / 60000} min) — surveille ${FILES_TO_SYNC.length} fichier(s) JSON local/Supabase, n'envoie que ceux qui ont changé. Cette sync est indépendante des collectes RSS/YouTube programmées (voir auto-collect-config.json / auto-collect-certamen-config.json).`
  );
}

module.exports = { init, downloadAll, uploadAll, startPeriodicSync };
