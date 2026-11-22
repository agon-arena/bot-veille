"use strict";
// Deployment maintenance switch, read once per process after dotenv. No timers or I/O.
// A non-empty unrecognised value fails closed; explicit off/false/0 restore old behaviour.
function getRuntimePolicy(env = process.env) {
  const value = String(env.BOT_SAFE_START || '').trim().toLowerCase();
  const safeStart = value !== '' && !['off', 'false', '0'].includes(value);
  const forced = String(env.BOT_AUTO_PIPELINES || '').trim().toLowerCase();
  const automaticPipelines = !safeStart && (forced === 'on' || (forced !== 'off' && Boolean(env.RENDER)));
  // SORTIR-only exception inside safe mode: only the SORTIR ingestion tick may run; every other
  // pipeline, Storage sync and mutation stays fenced. Exact "on" only; anything else fails closed.
  const sortirIngest = safeStart && String(env.BOT_SORTIR_INGEST || '').trim().toLowerCase() === 'on';
  return Object.freeze({ safeStart, automaticPipelines, sortirIngest });
}
const runtimePolicy = getRuntimePolicy();
function runAutomaticStartup(start, label) {
  if (runtimePolicy.safeStart) {
    console.log(`[safe-start] ${label}: tâches automatiques suspendues ; HTTP disponible.`);
    return false;
  }
  return start();
}
function safeStartMiddleware({ allowLogin = false } = {}) {
  return (req, res, next) => {
    if (!runtimePolicy.safeStart || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ||
      (allowLogin && req.method === 'POST' && req.path === '/mixte-login') ||
      (allowLogin && runtimePolicy.sortirIngest && req.method === 'POST' && req.path === '/api/sortir-ingest-tick')) return next();
    res.set('Cache-Control', 'no-store');
    return res.status(503).json({ ok: false, code: 'BOT_SAFE_START',
      error: 'Démarrage sécurisé : traitements et modifications temporairement suspendus.' });
  };
}
module.exports = { getRuntimePolicy, runtimePolicy, runAutomaticStartup, safeStartMiddleware };
