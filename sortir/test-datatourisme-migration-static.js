"use strict";
// Structural safety checks. Real PostgreSQL remains the SQL syntax/type validator.
const assert = require('assert/strict'), fs = require('fs'), path = require('path');
const sql = fs.readFileSync(path.join(__dirname, '../migrations/2026-10-21-sortir-datatourisme-poi-states.sql'), 'utf8');
const statements = sql.replace(/--[^\n]*/g, '').split(/\$\$/).filter((_, i) => i % 2 === 0).join(' SQL_BODY ').split(';').map(s => s.trim()).filter(Boolean);
const check = (name, fn) => { fn(); console.log('✓ '+name); };
check('une transaction unique englobe toute la migration', () => {
 assert.equal(statements[0].toLowerCase(), 'begin'); assert.equal(statements.at(-1).toLowerCase(), 'commit');
 assert.equal(statements.filter(s => /^begin$/i.test(s)).length, 1); assert.equal(statements.filter(s => /^commit$/i.test(s)).length, 1);
});
check('aucune mutation métier exécutée au niveau supérieur', () => { for (const s of statements.slice(1,-1)) assert.match(s, /^(create table|create function|alter table|comment on|revoke|grant)\b/i); });
check('quinze RPC invoker et search_path explicite', () => {
 const f=statements.filter(s => /^create function/i.test(s)); assert.equal(f.length,15);
 for(const s of f){assert.match(s,/security invoker/i);assert.match(s,/set search_path = public/i);assert.doesNotMatch(s,/security definer/i);}
});
check('chaque RPC est retirée des rôles publics puis accordée au service', () => {
 for(const f of statements.filter(s=>/^create function/i.test(s))){const name=f.match(/create function public\.(\w+)/i)[1];
 assert.ok(statements.some(s=>s.startsWith('revoke all on function public.'+name+'(')&&s.endsWith('from public, anon, authenticated')));
 assert.ok(statements.some(s=>s.startsWith('grant execute on function public.'+name+'(')&&s.endsWith('to service_role')));}
});
check('RLS et droits minimaux sur l’état POI', () => {
 assert.ok(statements.includes('alter table public.sortir_datatourisme_poi_states enable row level security'));
 assert.ok(statements.includes('grant select, insert, update on public.sortir_datatourisme_poi_states to service_role'));
 assert.ok(statements.includes('revoke all on public.sortir_datatourisme_poi_states from public, anon, authenticated'));
});
console.log('5 test(s) réussi(s), 0 échec(s).');
