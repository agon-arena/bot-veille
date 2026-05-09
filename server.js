const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();

const PORT = process.env.PORT || 3000;

const VEILLE_HTML = path.join(__dirname, "veille.html");
const VEILLE_YOUTUBE_HTML = path.join(__dirname, "veille-youtube.html");

function sendMissingPage(res, title, message) {
  return res.send(`
    <!DOCTYPE html>
    <html lang="fr">
    <head>
      <meta charset="UTF-8">
      <title>${title}</title>
    </head>
    <body style="font-family: system-ui; max-width: 800px; margin: 40px auto; padding: 0 16px;">
      <h1>${title}</h1>
      <p>${message}</p>
      <p>Attends quelques instants puis rafraîchis la page.</p>
      <p><a href="/">Articles</a> · <a href="/youtube">YouTube</a></p>
    </body>
    </html>
  `);
}

app.get("/", (req, res) => {
  if (!fs.existsSync(VEILLE_HTML)) {
    return sendMissingPage(
      res,
      "Veille médias",
      "La veille articles n'a pas encore été générée."
    );
  }

  res.sendFile(VEILLE_HTML);
});

app.get("/youtube", (req, res) => {
  if (!fs.existsSync(VEILLE_YOUTUBE_HTML)) {
    return sendMissingPage(
      res,
      "Veille YouTube",
      "La veille YouTube n'a pas encore été générée."
    );
  }

  res.sendFile(VEILLE_YOUTUBE_HTML);
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

app.get("/veille-youtube.json", (req, res) => {
  const filePath = path.join(__dirname, "veille-youtube.json");

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "veille-youtube.json non généré" });
  }

  res.sendFile(filePath);
});

app.get("/sessions-youtube.json", (req, res) => {
  const filePath = path.join(__dirname, "sessions-youtube.json");

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "sessions-youtube.json non généré" });
  }

  res.sendFile(filePath);
});

app.listen(PORT, () => {
  console.log(`Serveur lancé sur le port ${PORT}`);
});