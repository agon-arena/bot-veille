"use strict";
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const sql=fs.readFileSync(path.join(__dirname,'../migrations/2026-10-23-sortir-datatourisme-batch-selection-clock.sql'),'utf8');
for(const [name,fn]of [
 ['migration horloge : transaction unique',()=>{const top=sql.replace(/--[^\n]*/g,'').split('$$').filter((_,i)=>i%2===0).join('BODY');assert.equal((top.match(/\bbegin\s*;/gi)||[]).length,1);assert.equal((top.match(/\bcommit\s*;/gi)||[]).length,1);}],
 ['migration horloge : verrou, invoker, search_path, droits service uniquement',()=>{for(const re of [/for update/i,/security invoker/i,/set search_path = public/i,/from public,anon,authenticated/i,/to service_role/i])assert.match(sql,re);}],
 ['migration horloge : comparaison complète et rejet changement instant au rejeu',()=>{assert.match(sql,/pending'\) - 'selection_now'/);assert.match(sql,/recorded is distinct from p_selection_now/);assert.match(sql,/perform public.sortir_dt_observe_national_batch\(/);}],
 ['migration horloge : pas de validation empreinte ni acquittement',()=>{assert.doesNotMatch(sql,/update public.sortir_datatourisme_poi_states|finish_national|fingerprint\s*=/i);assert.match(sql,/\{pending,selection_now\}/);}]
]){fn();console.log('✓ '+name);}
