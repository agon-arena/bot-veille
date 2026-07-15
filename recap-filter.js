// Détection des articles "récap" multi-sujets (revue de presse, l'essentiel de la
// journée, brèves groupées…). Ces contenus mélangent plusieurs actualités sans lien :
// ils ne doivent jamais servir de source à un article Agôn, ni entrer dans la veille.
// Module partagé entre la collecte (veille-mixte.js) et la génération (server.js)
// pour que les deux barrières restent synchronisées.

const ROUNDUP_TITLE_PATTERNS = [
  /ce qu['’]?(il|on) (faut|sait)/i,
  /l['’]essentiel (de|du|des|à retenir)/i,
  /\ben bref\b/i,
  /faits marquants/i,
  /r[ée]sum[ée] de la (journ[ée]e|semaine|soir[ée]e)/i,
  /retour sur (la|le|les) (journ[ée]e|semaine)/i,
  /toute l['’]actualit[ée]/i,
  /revue de presse/i,
  // Motifs ajoutés le 15/07/2026 : récaps multi-sujets qui passaient le filtre.
  /\b(le|la|votre|notre) r[ée]cap\b/i,
  /\br[ée]cap(itulatif)?['’]? (de|du|des)\b/i,
  /[àa] retenir (de la (journ[ée]e|semaine|soir[ée]e|matin[ée]e|nuit)|du (jour|week[- ]?end)|de ce (lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche))/i,
  /les infos (de la (nuit|journ[ée]e|semaine)|du (jour|matin|soir|week[- ]?end))/i,
  /l['’]actu (du jour|de la (semaine|nuit)|en \d+ (infos?|minutes?|images?))/i,
  /pass[ée] cette (nuit|semaine)\b/i,
  /ne fallait pas (manquer|rater)/i,
  /tour d['’]horizon/i,
  /les titres (du|de la|de ce)/i,
  /la matinale (du|de)\b/i,
  /\ble brief\b/i,
  /\bzapping\b/i,
  /\bbest[- ]?of\b/i,
  /l['’]int[ée]grale (du|de)\b/i,
  /(trois|cinq|sept|dix|\d+) (infos|actus|infos essentielles) [àa] retenir/i,
  /\bJT de\b/i,
  /journal (t[ée]l[ée]vis[ée]|de \d{1,2}\s?h)/i,
  /\bflash info\b/i,
  /s[ée]lection de la r[ée]daction/i,
  /\bnewsletter\b/i
];

function isRoundupTitle(title) {
  const text = String(title || "");
  return ROUNDUP_TITLE_PATTERNS.some((pattern) => pattern.test(text));
}

module.exports = { ROUNDUP_TITLE_PATTERNS, isRoundupTitle };
