"use strict";
const fs = require('fs');
const tls = require('tls');
const { X509Certificate } = require('crypto');
const { parse } = require('pg-connection-string');

// Parse credentials without letting URL sslmode options replace the verified
// TLS object. No environment fallback to a privileged Supabase connection.
function recoveryConnectionConfig(env = process.env) {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw Error('TLS verification must remain enabled');
  if (!env.SORTIR_RECOVERY_DATABASE_URL) throw Error('Dedicated PostgreSQL URL required');
  const url = new URL(env.SORTIR_RECOVERY_DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw Error('PostgreSQL URL required');
  // Reject all driver overrides, including host, sslmode and uselibpqcompat:
  // host/port/credentials come only from the URI authority.
  if ([...url.searchParams].length) throw Error('Connection URL options forbidden; configure TLS with SORTIR_RECOVERY_CA_FILE');
  if (!env.SORTIR_RECOVERY_CA_FILE) throw Error('Explicit trusted SORTIR_RECOVERY_CA_FILE required');
  const ca = fs.readFileSync(env.SORTIR_RECOVERY_CA_FILE, 'utf8');
  if (/PRIVATE KEY/.test(ca)) throw Error('CA file must contain public certificates only');
  const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!certificates?.length || certificates.some(pem => !new X509Certificate(pem).ca)) throw Error('Trusted CA certificate required');
  tls.createSecureContext({ ca, minVersion: 'TLSv1.2' });
  const parsed = parse(url.toString());
  if (!parsed.user || !parsed.password || !parsed.database) throw Error('Explicit dedicated user, password and database required');
  if (parsed.user.split('.')[0] !== 'sortir_organizer_recovery_login') throw Error('Dedicated recovery login required');
  return {
    host: parsed.host, port: Number(parsed.port || 5432), database: parsed.database,
    user: parsed.user, password: parsed.password,
    ssl: { ca, rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: url.hostname, checkServerIdentity: tls.checkServerIdentity },
    application_name: 'sortir-organizer-recovery-v1', connectionTimeoutMillis: 20000, query_timeout: 65000
  };
}
module.exports = { recoveryConnectionConfig };
