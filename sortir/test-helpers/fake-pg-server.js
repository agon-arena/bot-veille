"use strict";
// Serveur PostgreSQL minimal (protocole v3, sans TLS) pour tester le vrai client pg :
// une requête contenant STALL ne reçoit sa réponse qu'après release(), comme une
// réponse retenue par une suspension réseau. Aucun accès externe.
const net = require('node:net');
const msg = (type, body) => { const head = Buffer.alloc(5); head.write(type, 0); head.writeInt32BE(body.length + 4, 1); return Buffer.concat([head, body]); };
const cstr = s => Buffer.from(s + '\0');
const int16 = n => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const int32 = n => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const READY = msg('Z', Buffer.from('I'));
function rowsFor(sql) {
  if (sql.includes("current_setting('default_transaction_read_only')")) return [{ backend_pid: 42, read_control_read_only: 'off', statement_timeout: '0', idle_timeout: '0' }];
  if (sql.includes("current_setting('transaction_read_only')")) return [{ backend_pid: 42, read_control_read_only: 'on' }];
  return null;
}
function result(sql, described) {
  const rows = rowsFor(sql), parts = [];
  if (rows) {
    const cols = Object.keys(rows[0]);
    if (described !== false) parts.push(msg('T', Buffer.concat([int16(cols.length), ...cols.map(c => Buffer.concat([cstr(c), int32(0), int16(0), int32(c === 'backend_pid' ? 23 : 25), int16(-1), int32(-1), int16(0)]))])));
    for (const r of rows) parts.push(msg('D', Buffer.concat([int16(cols.length), ...cols.map(c => { const v = Buffer.from(String(r[c])); return Buffer.concat([int32(v.length), v]); })])));
  } else if (described) parts.push(msg('n', Buffer.alloc(0)));
  parts.push(msg('C', cstr(`SELECT ${rows ? rows.length : 0}`)));
  return Buffer.concat(parts);
}
function startFakePg() {
  const held = [], sockets = new Set(), received = [], control = { stallWhen: sql => sql.includes('STALL') };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buf = Buffer.alloc(0), started = false, parsed = null, out = [];
    const send = data => { if (parsed?.stall || held.some(h => h.socket === socket)) held.push({ socket, data }); else socket.write(data); };
    socket.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (!started) {
          if (buf.length < 4) return; const len = buf.readInt32BE(0); if (buf.length < len) return;
          buf = buf.subarray(len); started = true;
          socket.write(Buffer.concat([msg('R', int32(0)), msg('K', Buffer.concat([int32(42), int32(7)])), READY])); continue;
        }
        if (buf.length < 5) return; const type = String.fromCharCode(buf[0]), len = buf.readInt32BE(1); if (buf.length < len + 1) return;
        const body = buf.subarray(5, len + 1); buf = buf.subarray(len + 1);
        if (type === 'X') { socket.end(); return; }
        if (type === 'Q') { const sql = body.toString('utf8', 0, body.length - 1); received.push(sql); parsed = { sql, stall: control.stallWhen(sql) }; send(Buffer.concat([result(sql), READY])); parsed = null; }
        else if (type === 'P') { const name = body.indexOf(0), end = body.indexOf(0, name + 1); const sql = body.toString('utf8', name + 1, end); received.push(sql); parsed = { sql, stall: control.stallWhen(sql), described: false }; out = [msg('1', Buffer.alloc(0))]; }
        else if (type === 'B') out.push(msg('2', Buffer.alloc(0)));
        else if (type === 'D') parsed.described = true;
        else if (type === 'E') out.push(result(parsed.sql, parsed.described));
        else if (type === 'S') { send(Buffer.concat([...out, READY])); parsed = null; out = []; }
      }
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, received,
    set stallWhen(fn) { control.stallWhen = fn; },
    release() { for (const h of held.splice(0)) if (!h.socket.destroyed) h.socket.write(h.data); },
    async close() { for (const s of sockets) s.destroy(); await new Promise(r => server.close(r)); }
  })));
}
module.exports = { startFakePg };
