"use strict";
// Garde d'hôte macOS pour la reprise locale : secteur, capot et suspension.
// Le 05/11/2026, une fermeture du capot sur batterie a suspendu le Mac au milieu
// d'une lecture ; caffeinate -s ne vaut que sur secteur et n'empêche pas la veille capot.
// Échec fermé : état inconnu ou trop ancien = hôte non sûr. La garde n'est consultée
// qu'aux points sûrs (avant un lot, pendant la revalidation en lecture seule, avant
// le writer) : jamais dans une transaction d'écriture.
const cp = require('node:child_process');
const { RecoveryStop } = require('./historical-recovery-supervisor');
function parseAcPower(text) { const m = /Now drawing from '([^']+)'/.exec(text || ''); return m ? m[1] === 'AC Power' : null; }
function parseLidClosed(text) { const m = /"AppleClamshellState"\s*=\s*(Yes|No)/.exec(text || ''); return m ? m[1] === 'Yes' : null; }
function execText(file, args) {
  return new Promise(resolve => cp.execFile(file, args, { timeout: 3000, encoding: 'utf8' }, (error, out) => resolve(error ? null : out)));
}
async function readHostPower(exec = execText) {
  const [battery, clamshell] = await Promise.all([exec('/usr/bin/pmset', ['-g', 'batt']), exec('/usr/sbin/ioreg', ['-r', '-k', 'AppleClamshellState', '-d', '1'])]);
  return { acPower: parseAcPower(battery), lidClosed: parseLidClosed(clamshell) };
}
function unsafeReason({ acPower, lidClosed }) {
  if (acPower !== true) return acPower === false ? 'battery_power' : 'power_unknown';
  if (lidClosed !== false) return lidClosed === true ? 'lid_closed' : 'lid_unknown';
  return null;
}
class HostGuard {
  constructor({ sample = readHostPower, now = Date.now, intervalMs = 5000, tickMs = 1000, suspendGapMs = 15000, staleMs = 30000, onEvent = () => {} } = {}) {
    Object.assign(this, { sample, now, intervalMs, tickMs, suspendGapMs, staleMs, onEvent });
    this.state = null; this.suspended = null; this.lastTick = now(); this.lastReason = undefined; this.busy = false;
  }
  async start() {
    this.lastTick = this.now(); await this.refresh();
    this.timer = setInterval(() => { this.refresh().catch(() => {}); }, this.intervalMs); this.timer.unref?.();
    this.ticker = setInterval(() => this.observeTick(), this.tickMs); this.ticker.unref?.();
    return this;
  }
  stop() { clearInterval(this.timer); clearInterval(this.ticker); }
  // Écart d'horloge murale entre deux tics : suspension système (ou boucle bloquée),
  // dans les deux cas un arrêt au prochain point sûr est la seule réaction admise.
  observeTick(at = this.now()) {
    const gapMs = at - this.lastTick; this.lastTick = at;
    if (gapMs > this.suspendGapMs && !this.suspended) { this.suspended = { at: new Date(at).toISOString(), gapMs }; this.onEvent({ event: 'host_suspension_detected', gapMs }); }
  }
  async refresh() {
    if (this.busy) return; this.busy = true;
    try {
      const sample = await this.sample(), reason = unsafeReason(sample);
      this.state = { ...sample, reason, at: this.now() };
      if (reason !== this.lastReason) { this.lastReason = reason; this.onEvent({ event: 'host_power_state', acPower: sample.acPower, lidClosed: sample.lidClosed, unsafe: reason }); }
    } finally { this.busy = false; }
  }
  problem() {
    this.observeTick();
    if (this.suspended) return 'host_suspended';
    if (!this.state || this.now() - this.state.at > this.staleMs) return 'power_state_stale';
    return this.state.reason;
  }
  summary() { return { acPower: this.state?.acPower ?? null, lidClosed: this.state?.lidClosed ?? null, unsafe: this.problem() }; }
  assertSafe(phase) {
    const reason = this.problem();
    if (reason) throw Object.assign(new RecoveryStop('HOST_UNSAFE', 'Hôte non sûr (secteur, capot ou suspension) : arrêt au point sûr.'), { hostReason: reason, hostPhase: phase });
  }
}
module.exports = { HostGuard, readHostPower, parseAcPower, parseLidClosed, unsafeReason };
