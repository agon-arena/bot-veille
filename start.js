const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const runtimeMetaPath = path.join(__dirname, ".bot-veille-runtime.json");
let shuttingDown = false;
let veilleMixteProcess = null;
let serverProcess = null;

// Journal persistant : la sortie des enfants est recopiée dans bot-veille.log
// (horodatée) en plus du terminal, pour pouvoir diagnostiquer après coup les
// incidents nocturnes (ex: échecs en série des idées IA sans trace exploitable).
const LOG_FILE = path.join(__dirname, "bot-veille.log");
const LOG_MAX_BYTES = 10 * 1024 * 1024;

function rotateLogIfTooBig() {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_FILE, LOG_FILE + ".old");
    }
  } catch (error) {
    console.warn("Rotation de bot-veille.log impossible :", error.message);
  }
}

rotateLogIfTooBig();
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });

function teeChildOutput(label, child) {
  for (const [source, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let buffer = "";
    source.setEncoding("utf8");
    source.on("data", (chunk) => {
      target.write(chunk);
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        logStream.write(new Date().toISOString() + " [" + label + "] " + line + "\n");
      }
    });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return false;
  }
}

function readRuntimeMeta() {
  try {
    return JSON.parse(fs.readFileSync(runtimeMetaPath, "utf8"));
  } catch (error) {
    return null;
  }
}

function writeRuntimeMeta() {
  const payload = {
    startedAt: new Date().toISOString(),
    launcherPid: process.pid,
    veilleMixtePid: veilleMixteProcess?.pid || null,
    serverPid: serverProcess?.pid || null
  };
  fs.writeFileSync(runtimeMetaPath, JSON.stringify(payload, null, 2), "utf8");
}

function removeRuntimeMeta() {
  try {
    if (fs.existsSync(runtimeMetaPath)) {
      fs.unlinkSync(runtimeMetaPath);
    }
  } catch (error) {
    console.warn("Impossible de supprimer le fichier runtime du bot veille :", error.message);
  }
}

async function terminatePid(pid, label) {
  if (!isAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    return;
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (!isAlive(pid)) return;
    await sleep(150);
  }

  if (isAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
      console.warn(label + " forcé à s'arrêter.");
    } catch (error) {
      return;
    }
  }
}

async function clearPreviousRuntime() {
  const previous = readRuntimeMeta();
  if (!previous) return;

  if (isAlive(previous.launcherPid)) {
    console.log("Arrêt de l'ancienne instance launcher (" + previous.launcherPid + ")...");
    await terminatePid(previous.launcherPid, "launcher");
  }

  const orphanTargets = [
    ["veille-mixte", previous.veilleMixtePid],
    ["server", previous.serverPid]
  ];

  for (const [label, pid] of orphanTargets) {
    if (isAlive(pid)) {
      console.log("Nettoyage de l'ancien " + label + " (" + pid + ")...");
      await terminatePid(pid, label);
    }
  }

  removeRuntimeMeta();
}

function getListeningPid(port) {
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8"
    }).trim();
    const pid = Number(output.split(/\s+/)[0] || 0);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch (error) {
    return null;
  }
}

async function clearOccupiedPorts() {
  const targets = [
    ["port-3000", getListeningPid(3000)],
    ["port-3002", getListeningPid(3002)]
  ];

  for (const [label, pid] of targets) {
    if (isAlive(pid)) {
      console.log("Nettoyage du " + label + " occupé par le PID " + pid + "...");
      await terminatePid(pid, label);
    }
  }
}

// Plafond de tas par process enfant : les 3 process Node partagent les 512 Mo de Render et,
// sans plafond, V8 laissait gonfler chaque tas bien au-delà de ses données vivantes (OOM du
// 31/10/2026). Mesuré le 01/11 : collecte complète OK à 128 Mo, publication < 72 Mo.
const CHILD_HEAP_MB = Number(process.env.BOT_CHILD_HEAP_MB) || 160;

// veille-mixte.js sort avec ce code quand server.js lui demande de se recycler (POST /recycle) :
// on le relance seul au lieu d'arrêter tout le bot.
const RECYCLE_EXIT_CODE = 75;

function spawnChild(label, script) {
  const child = spawn("node", [`--max-old-space-size=${CHILD_HEAP_MB}`, script], {
    cwd: __dirname,
    stdio: ["inherit", "pipe", "pipe"]
  });
  teeChildOutput(label, child);

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (code === RECYCLE_EXIT_CODE && child === veilleMixteProcess) {
      console.log(label + " recyclé (mémoire libérée), relance...");
      veilleMixteProcess = spawnChild(label, script);
      writeRuntimeMeta();
      return;
    }
    console.warn(label + " s'est arrêté" + (signal ? " (signal " + signal + ")" : " (code " + code + ")") + ".");
    void stopChildren(1);
  });

  child.on("error", (error) => {
    if (shuttingDown) return;
    console.error("Erreur de démarrage pour " + label + " :", error.message);
    void stopChildren(1);
  });

  return child;
}

async function stopChildren(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("Arrêt du bot de veille...");

  const tasks = [
    terminatePid(veilleMixteProcess?.pid, "veille-mixte"),
    terminatePid(serverProcess?.pid, "server")
  ];
  await Promise.all(tasks);
  removeRuntimeMeta();
  process.exit(exitCode);
}

async function main() {
  console.log("Démarrage du bot de veille...");
  await clearPreviousRuntime();
  await clearOccupiedPorts();

  veilleMixteProcess = spawnChild("veille-mixte.js", "veille-mixte.js");
  serverProcess = spawnChild("server.js", "server.js");
  writeRuntimeMeta();

  console.log("Instance active :", {
    launcherPid: process.pid,
    veilleMixtePid: veilleMixteProcess.pid,
    serverPid: serverProcess.pid
  });
}

process.on("SIGTERM", () => {
  void stopChildren(0);
});

process.on("SIGINT", () => {
  void stopChildren(0);
});

process.on("uncaughtException", (error) => {
  console.error("Erreur non gérée dans start.js :", error);
  void stopChildren(1);
});

process.on("unhandledRejection", (error) => {
  console.error("Promesse non gérée dans start.js :", error);
  void stopChildren(1);
});

void main();
