import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const MIGRATION_ID = 'jiangyin-room-to-waterbody-20261128-v1';
const EXPECTED_ROOM_IDS = ['group-rbtduba3','group-k7jcv64d','group-te0kzlak','group-pjdacjtn','group-espiothr','group-uk3wemf2','group-t0d0eyq8','group-poyj14js','group-7r7kr6rm','group-4fkru97w','group-f6leqri2','group-n4875ygr'];
const list = value => Array.isArray(value) ? value : [];
const roomLabel = name => /房间$|区$/.test(name) ? name : `${name}房间`;

export function planJiangyinTankGroups(tankGroups, { enforceProductionShape = true } = {}) {
  const groups = list(tankGroups), rooms = groups.filter(group => group.siteId === 'jiangyin');
  assert(rooms.length, 'No Jiangyin rooms found');
  assert(rooms.every(room => !room.legacyRoomId), 'Already migrated or mixed topology; refuse to repeat');
  if (enforceProductionShape) {
    assert.deepEqual(rooms.map(room => room.id).sort(), [...EXPECTED_ROOM_IDS].sort(), 'Room topology changed; inspect again');
    assert.equal(rooms.flatMap(room => list(room.subTanks)).length, 47, 'Compartment topology changed; inspect again');
  }
  const roomIds = new Set(rooms.map(room => room.id)), originalSubIds = groups.flatMap(group => list(group.subTanks).map(sub => sub.id));
  assert.equal(new Set(originalSubIds).size, originalSubIds.length, 'Duplicate original compartment IDs');
  const mapping = [], newGroups = [];
  for (const room of rooms) for (const sub of list(room.subTanks)) {
    assert(sub.id && sub.name && room.name, 'Missing identity or name');
    const newGroupId = `group-jy-${sub.id.replace(/^tank-/, '')}`;
    assert(!groups.some(group => group.id === newGroupId), 'New group ID already exists');
    const bucket = sub.name.trim() === '桶里';
    const name = bucket ? `${roomLabel(room.name)}的隔离桶` : /^\d+-[A-Z]-\d+$/.test(sub.name) ? sub.name : `${roomLabel(room.name)} · ${sub.name}`;
    const group = { ...room, id: newGroupId, name, location: roomLabel(room.name), rows: 1, cols: 1,
      legacyRoomId: room.id, legacyRoomName: room.name,
      subTanks: [{ ...sub, name: bucket ? '隔离桶' : '主缸', row: 1, col: 1 }] };
    newGroups.push(group);
    mapping.push({ oldGroupId: room.id, oldGroupName: room.name, subTankId: sub.id, oldSubTankName: sub.name,
      newGroupId, newGroupName: name, newSubTankName: group.subTanks[0].name, bucket });
  }
  if (enforceProductionShape) assert.equal(mapping.filter(row => row.bucket).length, 7, 'Bucket set changed; inspect again');
  assert.equal(new Set(newGroups.map(group => group.id)).size, newGroups.length, 'Duplicate new group IDs');
  assert.equal(new Set(newGroups.map(group => group.name)).size, newGroups.length, 'Duplicate new group names');
  const result = groups.flatMap(group => roomIds.has(group.id) ? newGroups.filter(next => next.legacyRoomId === group.id) : [group]);
  assert.deepEqual(result.flatMap(group => list(group.subTanks).map(sub => sub.id)).sort(), [...originalSubIds].sort(), 'Compartment IDs changed');
  assert.deepEqual(result.filter(group => group.siteId !== 'jiangyin'), groups.filter(group => group.siteId !== 'jiangyin'), 'Other sites changed');
  return { tankGroups: result, mapping, oldRoomIds: [...roomIds], emptyRoomIds: rooms.filter(room => !list(room.subTanks).length).map(room => room.id) };
}

async function rootHashes(client) {
  const rows = (await client.query("SELECT key,md5(value::text) hash FROM app_state,LATERAL jsonb_each(data) e(key,value) WHERE id='main' ORDER BY key")).rows;
  return Object.fromEntries(rows.map(row => [row.key,row.hash]));
}
async function historyFingerprint(client, key) {
  assert(['bioRecords','lossRecords'].includes(key));
  return (await client.query(`SELECT count(*)::int count,count(DISTINCT entry->>'id')::int distinct_ids,
    md5(COALESCE(json_agg(entry-'tankGroupId' ORDER BY ordinality),'[]'::json)::text) content_without_group
    FROM app_state,LATERAL jsonb_array_elements(data->'${key}') WITH ORDINALITY r(entry,ordinality) WHERE id='main'`)).rows[0];
}
async function summarize(client, plan) {
  const gids=plan.oldRoomIds, subs=plan.mapping.map(row=>row.subTankId), result={};
  for(const key of ['logs','waterQualityRecords','bioRecords','lossRecords']) {
    result[key]=(await client.query(`SELECT count(*)::int total,
      count(*) FILTER(WHERE entry->>'subTankId'=ANY($2::text[]))::int known_sub,
      count(*) FILTER(WHERE COALESCE(entry->>'siteId','')<>'jiangyin')::int non_jiangyin,
      count(*) FILTER(WHERE entry->>'tankGroupId'=ANY($3::text[]))::int empty_room_refs,
      count(*) FILTER(WHERE jsonb_typeof(entry->'syncedStockItemIds')='array')::int frozen
      FROM app_state,LATERAL jsonb_array_elements(data->'${key}') entry WHERE id='main' AND entry->>'tankGroupId'=ANY($1::text[])`,[gids,subs,plan.emptyRoomIds])).rows[0];
    assert.equal(result[key].non_jiangyin,0,`${key}: unexpected site`);
    assert.equal(result[key].empty_room_refs,0,`${key}: empty room has history`);
  }
  assert.equal(result.logs.total,result.logs.frozen,'Unfrozen old logs need explicit historical targets before migration');
  assert.equal(result.logs.known_sub,0,'New explicit-compartment logs appeared; inspect before migration');
  assert.equal(result.waterQualityRecords.known_sub,0,'New explicit water records appeared; inspect before migration');
  assert.equal(result.bioRecords.total,result.bioRecords.known_sub,'Unresolvable historical bio compartment');
  // Preserve unknown, deleted historical compartments in loss records; never infer from current fish location.
  for(const key of ['bioRecords','lossRecords']){
    const pairs=(await client.query(`SELECT count(*)::int paired FROM app_state,LATERAL jsonb_array_elements(data->'${key}') entry WHERE id='main'
      AND EXISTS(SELECT 1 FROM jsonb_array_elements($1::jsonb) map WHERE map->>'oldGroupId'=entry->>'tankGroupId' AND map->>'subTankId'=entry->>'subTankId')`,[JSON.stringify(plan.mapping)])).rows[0].paired;
    assert.equal(pairs,result[key].known_sub,`${key}: historical group/compartment pair mismatch`);result[key].paired=pairs;
  }
  result.unmappedLossRecordIds=(await client.query(`SELECT entry->>'id' id FROM app_state,LATERAL jsonb_array_elements(data->'lossRecords') entry WHERE id='main'
    AND entry->>'tankGroupId'=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($2::jsonb) map WHERE map->>'oldGroupId'=entry->>'tankGroupId' AND map->>'subTankId'=entry->>'subTankId') ORDER BY entry->>'id'`,[gids,JSON.stringify(plan.mapping)])).rows.map(row=>row.id);
  result.unknownLossLocations=result.unmappedLossRecordIds.length;
  const workbench=(await client.query("SELECT to_regclass('public.maintenance_workbench_sites')::text name")).rows[0].name;
  assert.equal(workbench,null,'Workbench table appeared; inspect and migrate its task/plan locations before continuing');
  result.stock=(await client.query("SELECT count(*)::int records,count(DISTINCT entry->>'id')::int distinct_ids FROM app_state,LATERAL jsonb_array_elements(data->'stock') entry WHERE id='main' AND entry->>'subTankId'=ANY($1::text[])",[subs])).rows[0];
  return result;
}

export async function runJiangyinTankMigration({ apply = false } = {}) {
  assert.equal(process.env.PGDATABASE,'fishroom','Production DB guard');
  assert.notEqual(process.env.FISHROOM_CLOUD_TEST,'true','Refuse cloud-test DB');
  const require=createRequire(existsSync('/app/package.json')?'/app/package.json':import.meta.url), {Client}=require('pg');
  const c=new Client();await c.connect();
  try {
    await c.query(apply?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query("SET LOCAL lock_timeout='8s'");await c.query("SET LOCAL statement_timeout='60s'");
    if(apply)await c.query("SELECT 1 FROM app_state WHERE id='main' FOR UPDATE");
    const original=(await c.query("SELECT data->'tankGroups' groups FROM app_state WHERE id='main'")).rows[0].groups;
    const existing=(await c.query("SELECT backup_id FROM app_state_manual_backups WHERE backup_id=$1",[MIGRATION_ID])).rows.length;
    if(existing){
      const changed=original.filter(group=>group.siteId==='jiangyin');
      assert.equal(changed.length,47,'Migration backup exists but current topology differs');assert(changed.every(group=>group.legacyRoomId&&group.subTanks?.length===1),'Migration state incomplete');
      await c.query('COMMIT');return {ok:true,alreadyApplied:true,migrationId:MIGRATION_ID,groups:changed.length};
    }
    const plan=planJiangyinTankGroups(original),summary=await summarize(c,plan), before=await rootHashes(c);
    const bioBefore=await historyFingerprint(c,'bioRecords'),lossBefore=await historyFingerprint(c,'lossRecords');
    const report={migrationId:MIGRATION_ID,mode:apply?'apply':'dry-run',oldRooms:plan.oldRoomIds.length,newGroups:plan.mapping.length,
      buckets:plan.mapping.filter(row=>row.bucket).length,removedEmptyRooms:plan.emptyRoomIds,summary,mapping:plan.mapping,beforeHashes:before,
      bioBefore,lossBefore,planSha256:createHash('sha256').update(JSON.stringify(plan)).digest('hex')};
    if(!apply){await c.query('COMMIT');return report;}
    await c.query("INSERT INTO app_state_manual_backups(backup_id,reason,data) SELECT $1,$2,data FROM app_state WHERE id='main'",[MIGRATION_ID,'江阴房间/缸组层级更正：同事务完整原库快照，保留子缸ID与原房间历史']);
    await c.query("CREATE TEMP TABLE jy_tank_mapping(old_group_id text,sub_id text PRIMARY KEY,new_group_id text) ON COMMIT DROP");
    await c.query("INSERT INTO jy_tank_mapping SELECT row->>'oldGroupId',row->>'subTankId',row->>'newGroupId' FROM jsonb_array_elements($1::jsonb) row",[JSON.stringify(plan.mapping)]);
    // One large field per write avoids multiplying full-state JSONB copies in memory.
    for(const key of ['bioRecords','lossRecords'])await c.query(`UPDATE app_state SET data=jsonb_set(data,'{${key}}',(
      SELECT COALESCE(json_agg(CASE WHEN m.new_group_id IS NULL THEN entry ELSE jsonb_set(entry,'{tankGroupId}',to_jsonb(m.new_group_id),false) END ORDER BY ordinality),'[]'::json)::jsonb
      FROM jsonb_array_elements(data->'${key}') WITH ORDINALITY r(entry,ordinality)
      LEFT JOIN jy_tank_mapping m ON m.old_group_id=entry->>'tankGroupId' AND m.sub_id=entry->>'subTankId'
    ),true),updated_at=now() WHERE id='main'`);
    await c.query("UPDATE app_state SET data=jsonb_set(data,'{tankGroups}',$1::jsonb,true),updated_at=now() WHERE id='main'",[JSON.stringify(plan.tankGroups)]);
    const audit={id:MIGRATION_ID,time:new Date().toISOString(),operator:'system:authorized-maintenance',module:'缸组管理',action:'修改记录',
      detail:'经用户授权直接修正江阴缸位层级：12个旧房间节点拆为47个独立缸组，每组一个子缸；保留全部子缸ID、鱼只、订单与原房间历史；7个桶里重命名为所属房间隔离桶。',migrationId:MIGRATION_ID};
    await c.query("UPDATE app_state SET data=jsonb_set(data,'{operationLogs}',$1::jsonb||COALESCE(data->'operationLogs','[]'::jsonb),true),updated_at=now() WHERE id='main'",[JSON.stringify([audit])]);
    const after=await rootHashes(c), allowed=new Set(['tankGroups','bioRecords','lossRecords','operationLogs']);
    assert.deepEqual(Object.keys(after),Object.keys(before),'Unexpected root keys');
    for(const key of Object.keys(before))if(!allowed.has(key))assert.equal(after[key],before[key],`${key} unexpectedly changed`);
    assert.deepEqual(await historyFingerprint(c,'bioRecords'),bioBefore,'Fish history altered beyond group reference');
    assert.deepEqual(await historyFingerprint(c,'lossRecords'),lossBefore,'Loss history altered beyond group reference');
    const remaining=await c.query("SELECT count(*)::int count FROM app_state,LATERAL jsonb_array_elements(data->'bioRecords') entry WHERE id='main' AND entry->>'tankGroupId'=ANY($1::text[])",[plan.oldRoomIds]);assert.equal(remaining.rows[0].count,0);
    const remainingLoss=(await c.query("SELECT entry->>'id' id FROM app_state,LATERAL jsonb_array_elements(data->'lossRecords') entry WHERE id='main' AND entry->>'tankGroupId'=ANY($1::text[]) ORDER BY entry->>'id'",[plan.oldRoomIds])).rows.map(row=>row.id);
    assert.deepEqual(remainingLoss,summary.unmappedLossRecordIds,'Unmapped historical loss set changed');
    const persisted=(await c.query("SELECT data->'tankGroups' groups FROM app_state WHERE id='main'")).rows[0].groups;
    assert.deepEqual(persisted,plan.tankGroups);assert.equal(persisted.filter(group=>group.siteId==='jiangyin').length,47);
    await c.query('COMMIT');return {...report,ok:true,afterHashes:after,preservedUnchangedKeys:Object.keys(before).filter(key=>!allowed.has(key)),bioAfter:bioBefore,lossAfter:lossBefore};
  }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{await c.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const args=new Set(process.argv.slice(2));const apply=args.has('--apply');
  if(apply)assert(args.has(`--confirm=${MIGRATION_ID}`),'Explicit migration confirmation missing');
  console.log(JSON.stringify(await runJiangyinTankMigration({apply}),null,2));
}
