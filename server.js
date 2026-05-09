const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 3000;
const VEILLE_HTML = path.join(__dirname, "veille.html");

app.get("/", (req, res) => {
  if (!fs.existsSync(VEILLE_HTML)) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="fr">
      <head>
        <meta charset="UTF-8">
        <title>Veille médias</title>
      </head>
      <body style="font-family: system-ui; max-width: 800px; margin: 40px auto; padding: 0 16px;">
        <h1>Veille médias</h1>
        <p>La veille n'a pas encore été générée.</p>
        <p>Attends quelques instants puis rafraîchis la page.</p>
      </body>
      </html>
    `);
  }

  res.sendFile(VEILLE_HTML);
});

app.get("/veille.json", (req, res) => {
  const filePath = path.join(__dirname, "veille.json");

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "veille.json non généré" });
  }

  res.sendFile(filePath);
});

app.get("/sessions-veille.json", (req, res) => {
  const filePath = path.join(__dirname, "sessions-veille.json");

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "sessions-veille.json non généré" });
  }

  res.sendFile(filePath);
});

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});