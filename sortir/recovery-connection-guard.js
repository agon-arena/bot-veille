"use strict";
// Connexion PostgreSQL de reprise (hors codeHash du writer scellé).
// Après un délai client dépassé ou une faute réseau, la connexion n'est jamais
// réutilisée : pg laisse la requête expirée active sur le socket et mettrait en file
// la requête suivante derrière elle (attente de 49,7 s observée le 05/11/2026).
// Les délais existants (connectionTimeoutMillis, query_timeout) restent inchangés.
const CLIENT_MESSAGES = new Map([
  ['Query read timeout', 'client_read_timeout'],
  ['timeout expired', 'connection_timeout'],
  ['Connection terminated', 'connection_terminated'],
  ['Connection terminated unexpectedly', 'connection_terminated'],
  ['Connection terminated due to connection timeout', 'connection_timeout'],
  ['Client has encountered a connection error and is not queryable', 'connection_unusable'],
  ['Client was closed and is not queryable', 'connection_closed']
]);
const CLIENT_CODES = { client_read_timeout: 'CLIENT_QUERY_TIMEOUT', connection_timeout: 'CLIENT_CONNECT_TIMEOUT' };
const POISONING = new Set(['client_read_timeout', 'connection_timeout', 'connection_terminated', 'connection_unusable', 'connection_closed', 'network', 'connection_poisoned']);
// Classification sans secret : jamais le texte d'une erreur serveur (il peut contenir
// des valeurs métier), seulement des messages client connus de pg.
function classifyError(error) {
  const code = typeof error?.code === 'string' ? error.code : null, message = typeof error?.message === 'string' ? error.message : '';
  if (error?.poisoned) return { kind: 'connection_poisoned', code: code || 'CONNECTION_POISONED', reason: error.reason || null };
  const client = CLIENT_MESSAGES.get(message);
  if (client) return { kind: client, code: code || CLIENT_CODES[client] || null, clientMessage: message };
  if (/^[0-9A-Z]{5}$/.test(code || '') && error.severity)
    return { kind: 'server_error', code, sqlstate: code, severity: error.severity, routine: typeof error.routine === 'string' ? error.routine : null };
  if (/^E[A-Z_]+$/.test(code || '')) return { kind: 'network', code };
  return { kind: code ? 'coded' : 'local', code };
}
function openGuardedClient(Client, config, { onEvent = () => {}, endTimeoutMs = 5000, keepAliveInitialDelayMillis = 10000 } = {}) {
  // Keepalive TCP : une connexion morte sans RST est signalée par le noyau au lieu
  // d'attendre seulement le délai client.
  const raw = new Client({ ...config, keepAlive: true, keepAliveInitialDelayMillis });
  let fault = null, rejectFault;
  const failed = new Promise((_, reject) => { rejectFault = reject; }); failed.catch(() => {});
  const stream = () => raw.connection?.stream;
  function poison(reason, cause, extra = {}) {
    if (fault) return fault;
    const cls = classifyError(cause);
    // Une faute socket reste l'erreur d'origine (même code, même classement retry
    // qu'avant) ; un délai client devient une connexion définitivement abandonnée.
    fault = reason === 'socket_error' && cause instanceof Error ? Object.assign(cause, { poisoned: true, reason })
      : Object.assign(new Error('Connexion de reprise abandonnée après incident client ou réseau.'), { code: 'CONNECTION_POISONED', poisoned: true, reason });
    rejectFault(fault);
    try { stream()?.destroy(); } catch {}
    onEvent({ event: 'connection_poisoned', reason, causeKind: cls.kind, causeCode: cls.code, ...extra });
    return fault;
  }
  raw.on('error', error => poison('socket_error', error));
  return {
    raw,
    get poisoned() { return !!fault; },
    async connect() {
      try { await raw.connect(); }
      catch (error) { const c = classifyError(error); if (!error.code && CLIENT_CODES[c.kind]) error.code = CLIENT_CODES[c.kind]; poison('connect_failed', error); throw error; }
    },
    async query(...args) {
      if (fault) throw fault;
      const s = stream(), written = s?.bytesWritten, read = s?.bytesRead, started = Date.now();
      try { return await Promise.race([raw.query(...args), failed]); }
      catch (error) {
        if (error === fault) throw error;
        const c = classifyError(error);
        if (!error.code && CLIENT_CODES[c.kind]) error.code = CLIENT_CODES[c.kind];
        if (POISONING.has(c.kind)) {
          // Octets confiés au socket / reçus pendant la requête : distingue une requête
          // jamais partie d'une réponse jamais reçue (diagnostic, sans contenu).
          poison(c.kind, error, { elapsedMs: Date.now() - started,
            bytesWrittenDuringQuery: Number.isFinite(written) && Number.isFinite(s?.bytesWritten) ? s.bytesWritten - written : null,
            bytesReadDuringQuery: Number.isFinite(read) && Number.isFinite(s?.bytesRead) ? s.bytesRead - read : null });
        }
        throw error;
      }
    },
    async end() {
      const s = stream();
      if (fault) { try { s?.destroy(); } catch {} return; }
      let timer;
      try { await Promise.race([raw.end().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, endTimeoutMs); })]); }
      finally { clearTimeout(timer); if (s && !s.destroyed) { try { s.destroy(); } catch {} } }
    }
  };
}
module.exports = { classifyError, openGuardedClient, CLIENT_CODES };
