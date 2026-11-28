import test from 'node:test';import assert from 'node:assert/strict';
import {planJiangyinTankGroups} from './jiangyin-tank-restructure.mjs';
const room=(id,name,subTanks,extra={})=>({id,name,siteId:'jiangyin',location:'旧位置',rows:3,cols:4,subTanks,...extra});
const other={id:'nanjing',name:'南京缸',siteId:'nanjing',subTanks:[{id:'nj-sub',name:'保留'}]};
const run=groups=>planJiangyinTankGroups(groups,{enforceProductionShape:false});
test('one current compartment becomes one water body and preserves identity and other sites',()=>{
 const input=[other,room('r1','1-A',[{id:'tank-a',name:'1-A-1',row:3,col:4},{id:'tank-b',name:'桶里'}],{waterQualityParameterIds:['salinity','copper']})];
 const before=structuredClone(input), result=run(input);assert.deepEqual(input,before);assert.deepEqual(result.tankGroups[0],other);
 const [a,b]=result.tankGroups.slice(1);assert.equal(a.id,'group-jy-a');assert.equal(a.name,'1-A-1');assert.equal(a.subTanks[0].id,'tank-a');assert.equal(a.subTanks[0].name,'主缸');assert.equal(a.rows,1);assert.equal(a.cols,1);assert.equal(a.subTanks[0].row,1);assert.equal(a.legacyRoomId,'r1');assert.equal(a.legacyRoomName,'1-A');assert.deepEqual(a.waterQualityParameterIds,['salinity','copper']);assert.equal(b.name,'1-A房间的隔离桶');assert.equal(b.subTanks[0].name,'隔离桶');
});
test('generic old tank names include room context and empty rooms create no fake tanks',()=>{const r=run([room('r1','2-A',[{id:'treatment',name:'治疗缸'}]),room('r2','2-C',[]),room('r3','一楼治疗区',[{id:'bucket',name:'桶里'}])]);assert.equal(r.mapping.length,2);assert.deepEqual(r.emptyRoomIds,['r2']);assert.equal(r.mapping[0].newGroupName,'2-A房间 · 治疗缸');assert.equal(r.mapping[1].newGroupName,'一楼治疗区的隔离桶');});
test('duplicate identities, names, collision or repeated migration fail closed',()=>{
 assert.throws(()=>run([room('r1','1-A',[{id:'a',name:'1-A-1'},{id:'a',name:'1-A-2'}])]),/Duplicate original/);
 assert.throws(()=>run([room('r1','1-A',[{id:'a',name:'1-A-1'},{id:'b',name:'1-A-1'}])]),/Duplicate new group names/);
 assert.throws(()=>run([{...other,id:'group-jy-a'},room('r1','1-A',[{id:'tank-a',name:'1-A-1'}])]),/already exists/);
 assert.throws(()=>run([room('r1','1-A',[],{legacyRoomId:'old'})]),/Already migrated/);
});
test('production shape guard refuses a partial or changed room set',()=>{assert.throws(()=>planJiangyinTankGroups([room('r1','1-A',[])]),/Room topology changed/);});
