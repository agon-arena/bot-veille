"use strict";
// Dedicated offline child, never a service. Parent SIGKILLs after persistence starts.
const { MemoryStore } = require('./memory-store'), { schedulerClient } = require('./scheduler-client');
const { createSchedulerState } = require('../scheduler-state');
const { runSortirIngestTickIfDue, OPENAGENDA_SOURCES } = require('../../sortir-auto-ingest');
global.fetch = async () => { throw Error('External network forbidden'); };
process.env.OPENAGENDA_PUBLIC_KEY = 'offline-only';
const db = new MemoryStore(), client = schedulerClient(db);
db.countFinalActivities = async () => { process.send({ snapshot: db }); return new Promise(() => {}); };
setInterval(() => {}, 1000);
runSortirIngestTickIfDue({ now: new Date('2026-11-20T00:05:00Z'), client, store: db, state: createSchedulerState(client),
  openAgendaSources: [OPENAGENDA_SOURCES[0]], reunionSources: [], parisSources: [], datatourismeMaxTotalPois: 0,
  fetchEvents: async () => ({ results: [], fetchedCount: 0 }) }).catch(error => { console.error(error); process.exit(1); });
