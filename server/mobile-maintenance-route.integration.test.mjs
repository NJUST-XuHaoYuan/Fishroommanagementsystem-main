import assert from "node:assert/strict";
import test from "node:test";
import { startMutableRouteServer } from "./test-support/mutable-route-server.mjs";
import { stockPricingFixture, PRICING_TEST_PASSWORD } from "./test-support/stock-pricing-fixture.mjs";
const ok = r => assert.equal(r.response.status, 200, JSON.stringify(r.body));
const date = "2026-11-01T10:00:00";
async function setup(t) {
  const fixture = structuredClone(stockPricingFixture);
  fixture.state.tankGroups[0].subTanks.push({id:"tank-n2",name:"N2"});
  fixture.state.stock.push({...fixture.state.stock[0],id:"other-tank",subTankId:"tank-n2"});
  fixture.state.stock.push({...fixture.state.stock[0],id:"in-transit",tankTransfer:{id:"move-1",status:"in_transit",fromSiteId:"nanjing",fromSubTankId:"tank-n",issuedAt:date}});
  fixture.state.logs = [];
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
