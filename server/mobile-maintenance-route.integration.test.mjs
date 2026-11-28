import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";
const ok = r => assert.equal(r.response.status, 200, JSON.stringify(r.body));
const date = "2026-11-01T10:00:00";
async function setup(t, mutate = () => {}) {
  const fixture = structuredClone(stockPricingFixture);
  fixture.state.tankGroups[0].subTanks.push({id:"tank-n2",name:"N2"});
  fixture.state.stock.push({...fixture.state.stock[0],id:"other-tank",subTankId:"tank-n2"});
  fixture.state.stock.push({...fixture.state.stock[0],id:"in-transit",tankTransfer:{id:"move-1",status:"in_transit",fromSiteId:"nanjing",fromSubTankId:"tank-n",issuedAt:date}});
  fixture.state.logs = [];
  mutate(fixture.state);
  const server = await startMutableRouteServer(fixture); t.after(()=>server.stop());
  const tokens = {};
  for (const name of ["admin","editor","viewer"]) tokens[name]=await server.login(`pricing-${name}`,PRICING_TEST_PASSWORD);
  return {...server,tokens,
    log:(log,role="editor",extra={})=>server.request("/api/daily-logs/save",{token:tokens[role],body:{log,createOnly:true,...extra}}),
    history:(query="",role="editor")=>server.request(`/api/mobile-maintenance/history?siteId=nanjing${query}`,{token:tokens[role]}),
    bio:(stockItemId,id="mobile-bio",extra={})=>server.request("/api/bio-records/save",{token:tokens.editor,body:{action:"create",stockItemId,expectedSubTankId:"tank-n",record:{id,stockItemId,date,text:"治疗：观察并记录实际用药",photos:["/uploads/fish.jpg"],videos:[]},...extra}})
  };
}
const log = (id,extra={})=>({id,date,tankGroupId:"group-n",subTankId:"tank-n",action:"观察",notes:"本次维护",photos:["/uploads/tank.jpg"],videos:["/uploads/tank.mp4"],operator:"forged",...extra});

test("sub-tank log syncs only its fish and retains photos plus creator; legacy whole group remains supported",async t=>{
 const s=await setup(t); ok(await s.log(log("sub")));
 let state=await s.readPersistedState(); const saved=state.logs.find(r=>r.id==="sub");
 assert.equal(saved.subTankId,"tank-n"); assert.equal(saved.operator,"pricing-editor"); assert.equal(saved.createdBy,"pricing-editor");
 const linked=state.bioRecords.filter(r=>r.sourceLogId==="sub"); assert.ok(linked.length>0);
 assert.ok(linked.every(r=>r.subTankId==="tank-n")); assert.ok(!linked.some(r=>["other-tank","lost","shipment-shipped"].includes(r.stockItemId)));
 assert.deepEqual(saved.photos,["/uploads/tank.jpg"]); assert.deepEqual(saved.videos,["/uploads/tank.mp4"]);
 assert.ok(linked.every(record=>record.photos.length===0 && record.videos.length===0),"tank media must not become individual fish thumbnails");
 ok(await s.log(log("whole",{subTankId:""})));
 state=await s.readPersistedState(); assert.ok(state.bioRecords.some(r=>r.sourceLogId==="whole"&&r.stockItemId==="other-tank"));
 // Old desktop forms omit new fields: an edit must not silently broaden the scope or delete media.
 const oldEditor={id:"sub",date,tankGroupId:"group-n",action:"观察",notes:"更正"};
 ok(await s.log(oldEditor,"admin",{createOnly:false})); state=await s.readPersistedState();
 const edited=state.logs.find(r=>r.id==="sub"); assert.equal(edited.subTankId,"tank-n"); assert.equal(edited.createdBy,"pricing-editor"); assert.deepEqual(edited.photos,["/uploads/tank.jpg"]);
 assert.equal((await s.log(log("bad",{subTankId:"tank-j"}))).response.status,404);
 assert.equal((await s.log(log("bad-media",{photos:["javascript:alert(1)"]}))).response.status,400);
 assert.equal((await s.log(log("cross",{tankGroupId:"group-j",subTankId:"tank-j"}))).response.status,403);
 assert.equal((await s.log(log("forbidden"),"viewer")).response.status,403);
});

test("create-only retries need no update right and never overwrite another user's or changed record",async t=>{
 const s=await setup(t); await s.patchTestPersonnel("pricing-editor",{permissions:{daily:{create:true,update:false,delete:false}}});
 ok(await s.log(log("retry"))); const retry=await s.log(log("retry"));ok(retry);assert.equal(retry.body.idempotent,true);
 assert.equal((await s.readPersistedState()).logs.length,1);
 assert.equal((await s.log(log("retry",{notes:"changed"}))).response.status,409);
 assert.equal((await s.log(log("retry"),"admin")).response.status,409);
});

test("water medication and tests force group scope and sync every physically present fish without copying tank media", async t => {
 const s=await setup(t);
 for (const [i,action] of ["下药","水体下药","治疗","下药治疗","水质","测水质","水质测试","水质检测"].entries()) {
   const id=`shared-${i}`; const request=log(id,{action,scope:"subTank"}); const response=await s.log(request);ok(response);
   assert.equal(response.body.changedLog.scope,"group");assert.equal(response.body.changedLog.subTankId,undefined);
   assert.equal(response.body.changedLog.recordedFromSubTankId,"tank-n");
   const state=await s.readPersistedState(); const links=state.bioRecords.filter(r=>r.sourceLogId===id);
   assert(links.some(r=>r.stockItemId==="other-tank"));assert(links.some(r=>r.stockItemId==="follower"));
   assert(!links.some(r=>["lost","shipment-shipped","in-transit","PRIVATE_JY_FOLLOWER"].includes(r.stockItemId)));
   assert(links.every(r=>r.photos.length===0&&r.videos.length===0&&r.text.startsWith("缸组养护")));
   const retry=await s.log(request);ok(retry);assert.equal(retry.body.idempotent,true);
 }
 const shared=await s.log(log("explicit-group",{action:"观察",scope:"group"}));ok(shared);assert.equal(shared.body.changedLog.subTankId,undefined);
 assert.equal((await s.log(log("wrong-source",{action:"下药",subTankId:"tank-j"}))).response.status,404);
 const h=await s.history("&subTankId=tank-n2");ok(h);assert.equal(h.body.logs.length,9);
});

test("group history shares legacy water operations across compartments while other logs and single-fish treatment stay local",async t=>{
 const legacy={...log("legacy-drug",{action:"下药",operator:"pricing-editor",subTankId:"removed-compartment"}),syncedStockItemIds:["follower"]};
 const s=await setup(t,state=>{
   state.logs=[legacy];
   state.tankGroups.push({id:"group-other",siteId:"nanjing",name:"另一水体",subTanks:[{id:"tank-other",name:"Other"}]});
 });
 const before=await s.readPersistedState(); const retry=await s.log(legacy);ok(retry);assert.equal(retry.body.idempotent,true);
 assert.deepEqual(await s.readPersistedState(),before);
 ok(await s.log(log("sub-observation")));ok(await s.bio("follower"));
 ok(await s.log(log("other-group",{tankGroupId:"group-other",subTankId:"tank-other",action:"下药"})));
 const sub=await s.history("&subTankId=tank-n2");ok(sub);assert.deepEqual(sub.body.logs.map(r=>r.id),["legacy-drug"]);assert.equal(sub.body.bioRecords.length,0);
 const group=await s.history("&tankGroupId=group-n");ok(group);assert.equal(group.body.tankGroupId,"group-n");
 assert.deepEqual(new Set(group.body.logs.map(r=>r.id)),new Set(["legacy-drug","sub-observation"]));assert.equal(group.body.bioRecords.length,1);
 assert.equal((await s.history("&tankGroupId=group-other&subTankId=tank-n")).response.status,404);
 assert.equal((await s.history("&tankGroupId=group-j")).response.status,404);
 const changed=await s.log({...legacy,notes:"仅修正用药备注"},"admin",{createOnly:false});ok(changed);
 assert.equal(changed.body.changedLog.scope,"group");assert.equal(changed.body.changedLog.subTankId,undefined);
 assert.equal(changed.body.changedLog.recordedFromSubTankId,"removed-compartment");
 const state=await s.readPersistedState();assert(!state.bioRecords.some(r=>r.sourceLogId===legacy.id&&r.stockItemId==="other-tank"),"normalizing an old entry must not add today's fish to past treatment");
 assert.equal(state.logs.find(r=>r.id==="sub-observation").subTankId,"tank-n");
});

test("editing legacy compartment medication preserves its original moved, lost and removed fish history instead of treating new arrivals",async t=>{
 const ids=["follower","lost","removed-fish"];
 const old=log("old-treatment",{action:"下药",operator:"pricing-editor",syncedStockItemIds:ids});
 const s=await setup(t,state=>{
   state.logs=[old];
   state.tankGroups.push({id:"group-new",siteId:"nanjing",name:"转入水体",subTanks:[{id:"tank-new",name:"New"}]});
   state.stock=state.stock.map(f=>f.id==="follower"?{...f,subTankId:"tank-new"}:f);
   state.bioRecords=[...(state.bioRecords??[]),...ids.map(id=>({id:`old-bio-${id}`,stockItemId:id,sourceType:"dailyLog",sourceLogId:old.id,siteId:"nanjing",tankGroupId:"group-n",tankGroupName:"原水体",subTankId:"tank-n",subTankName:"原格子",tankLocation:"原位置",date,operator:"pricing-editor",text:"旧记录",photos:[],videos:[]}))];
 });
 const before=await s.readPersistedState();
 const result=await s.log({...old,notes:"修正剂量文字"},"admin",{createOnly:false});ok(result);
 const after=await s.readPersistedState();const links=after.bioRecords.filter(r=>r.sourceLogId===old.id);
 assert.deepEqual(new Set(links.map(r=>r.stockItemId)),new Set(ids));
 assert.deepEqual(new Set(after.logs.find(r=>r.id===old.id).syncedStockItemIds),new Set(ids));
 for(const entry of links){assert.equal(entry.subTankId,"tank-n");assert.equal(entry.subTankName,"原格子");assert.equal(entry.tankGroupName,"原水体");assert(entry.text.includes("修正剂量文字"));}
 assert.deepEqual(after.stock,before.stock);
 assert.deepEqual(after.bioRecords.filter(r=>r.sourceLogId!==old.id),before.bioRecords.filter(r=>r.sourceLogId!==old.id));
});

test("single fish record rejects stale tank, loss/outbound/transfer, and retries a stable id only once",async t=>{
 const s=await setup(t); ok(await s.bio("follower")); const retry=await s.bio("follower");ok(retry);assert.equal(retry.body.idempotent,true);
 const state=await s.readPersistedState();assert.equal(state.bioRecords.filter(r=>r.id==="mobile-bio").length,1);assert.equal(state.bioRecords.find(r=>r.id==="mobile-bio").subTankId,"tank-n");
 assert.equal((await s.bio("other-tank","wrong-tank")).response.status,409);
 for(const fish of ["lost","shipment-shipped"]) assert.notEqual((await s.bio(fish,fish)).response.status,200);
 assert.equal((await s.bio("in-transit","in-transit")).response.status,409);
 assert.equal((await s.bio("PRIVATE_JY_FOLLOWER","private")).response.status,404);
});

test("personal history is site-and-owner scoped, excludes synchronized duplicates and bounds the combined result",async t=>{
 const s=await setup(t);ok(await s.log(log("mine")));ok(await s.log(log("other-user"),"admin"));ok(await s.bio("follower"));
 const history=await s.history("&subTankId=tank-n");ok(history);assert.deepEqual(history.body.logs.map(r=>r.id),["mine"]);assert.deepEqual(history.body.bioRecords.map(r=>r.id),["mobile-bio"]);
 const bounded=await s.history("&limit=1");ok(bounded);assert.equal(bounded.body.logs.length+bounded.body.bioRecords.length,1);assert.equal(bounded.body.truncated,true);
 assert.equal((await s.history("&subTankId=tank-j")).response.status,404);
 assert.equal((await s.history("&limit=101")).response.status,400);
 assert.equal((await s.history("","viewer")).response.status,403);
 assert.equal((await s.request("/api/mobile-maintenance/history?siteId=jiangyin",{token:s.tokens.editor})).response.status,403);
 await s.patchTestPersonnel("pricing-editor",{accountEnabled:false}); assert.equal((await s.history()).response.status,401);
});


test("editing and deleting a tank log preserve unrelated history and remove its synchronized records", async t => {
 const s=await setup(t);ok(await s.bio("follower","unrelated-manual"));
 ok(await s.log(log("preserved")));ok(await s.log(log("changed")));
 const before=await s.readPersistedState();
 const preserved=before.bioRecords.filter(r=>r.sourceLogId!=="changed");
 ok(await s.log(log("changed",{notes:"第二次维护内容"}),"admin",{createOnly:false}));
 let state=await s.readPersistedState();
 assert.deepEqual(state.bioRecords.filter(r=>r.sourceLogId!=="changed"),preserved);
 const changed=state.bioRecords.filter(r=>r.sourceLogId==="changed");
 assert.equal(changed.length,before.bioRecords.filter(r=>r.sourceLogId==="changed").length);
 assert.ok(changed.every(r=>r.text.includes("第二次维护内容")));
 ok(await s.request("/api/daily-logs/save",{token:s.tokens.admin,body:{deleteId:"changed"}}));
 state=await s.readPersistedState();
 assert.deepEqual(state.bioRecords,preserved);
 assert.equal(state.logs.some(r=>r.id==="changed"),false);
 assert.equal(state.logs.some(r=>r.id==="preserved"),true);
 assert.equal(state.operationLogs[0].action,"删除记录");
});
