const { spawn } = require("child_process");

console.log("Démarrage du bot de veille...");

const veilleArticlesProcess = spawn("node", ["veille.js"], {
  stdio: "inherit"
});

const veilleYoutubeProcess = spawn("node", ["veille-youtube.js"], {
  stdio: "inherit"
});

const veilleMixteProcess = spawn("node", ["veille-mixte.js"], {
  stdio: "inherit"
});

const serverProcess = spawn("node", ["server.js"], {
  stdio: "inherit"
});

function stopChildren() {
  console.log("Arrêt du bot de veille...");
  veilleArticlesProcess.kill();
  veilleYoutubeProcess.kill();
  veilleMixteProcess.kill();
  serverProcess.kill();
  process.exit();
}

process.on("SIGTERM", stopChildren);
process.on("SIGINT", stopChildren);