const { spawn } = require("child_process");

console.log("Démarrage du bot de veille...");

const veilleMixteProcess = spawn("node", ["veille-mixte.js"], {
  stdio: "inherit"
});

const serverProcess = spawn("node", ["server.js"], {
  stdio: "inherit"
});

function stopChildren() {
  console.log("Arrêt du bot de veille...");
  veilleMixteProcess.kill();
  serverProcess.kill();
  process.exit();
}

process.on("SIGTERM", stopChildren);
process.on("SIGINT", stopChildren);