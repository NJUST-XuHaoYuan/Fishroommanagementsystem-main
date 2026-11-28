import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';
let vite, helper;
before(async () => { vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] } }); helper = await vite.ssrLoadModule('/src/app/utils/maintenancePlanTargets.ts'); });
after(async () => { await vite?.close(); });
test('maintenance operations preserve group versus fish scope and exclude loss', () => {
  for (const type of ['feeding', 'water_change', 'measurement']) { assert.equal(helper.maintenanceTypeAllowed('group', type), true); assert.equal(helper.maintenanceTypeAllowed('fish', type), false); }
  for (const type of ['inspection', 'treatment', 'other']) assert.equal(helper.maintenanceTypeAllowed('fish', type), true);
  assert.equal(helper.maintenanceTypeAllowed('group', 'media'), false);
  assert.equal(helper.maintenanceTypeAllowed('fish', 'media'), true);
  assert.equal(helper.maintenanceTypeAllowed('group', 'loss'), false);
  assert.equal(helper.maintenanceTypeAllowed('fish', 'loss'), false);
  assert.equal(helper.maintenanceRecordAction('treatment', 'group'), '下药');
  assert.equal(helper.maintenanceRecordAction('treatment', 'fish'), '治疗');
});
test('batch filter maps current live physical fish to groups without including lost or transferred fish', () => {
  const groups = [{id:'g1',siteId:'nanjing',name:'一',subTanks:[{id:'a'}]}, {id:'g2',siteId:'nanjing',name:'二',subTanks:[{id:'b'}]}, {id:'g3',siteId:'jiangyin',name:'三',subTanks:[{id:'c'}]}, {id:'g4',siteId:'nanjing',name:'空缸',subTanks:[]}];
  const stock = [
    {id:'live',batchId:'batch',siteId:'nanjing',subTankId:'a',status:'healthy'},
    {id:'sold-not-shipped',batchId:'batch',siteId:'nanjing',subTankId:'a',status:'healthy',sold:true},
    {id:'lost',batchId:'batch',siteId:'nanjing',subTankId:'b',status:'healthy',lost:true},
    {id:'transit',batchId:'batch',siteId:'nanjing',subTankId:'b',status:'healthy',tankTransfer:{status:'in_transit'}},
    {id:'otherbatch',batchId:'other',siteId:'nanjing',subTankId:'b',status:'healthy'},
    {id:'other-site',batchId:'batch',siteId:'jiangyin',subTankId:'c',status:'healthy'},
  ];
  const state = {tankGroups:groups,stock,orders:[],shipments:[],inventoryProjection:{outStockIds:['shipped']}};
  const filtered = helper.maintenancePlanTargets(state,'nanjing','batch');
  assert.deepEqual(filtered.groups.map(group=>group.id), ['g1']);
  assert.deepEqual(filtered.fish.map(fish=>fish.id), ['live','sold-not-shipped']);
  assert.deepEqual(helper.maintenancePlanTargets(state,'nanjing').groups.map(group=>group.id),['g1','g2','g4']);
});
test('targets are distinct per fish and group, while action labels stay actual records', () => {
  assert.equal(helper.maintenanceTargetKey({targetType:'group',tankId:'g'}),'group:g');
  assert.equal(helper.maintenanceTargetKey({targetType:'fish',tankId:'g',stockItemId:'f'}),'fish:f');
  assert.equal(helper.maintenanceRecordAction('measurement','group'),'水质');
  assert.equal(helper.maintenanceRecordAction('media','fish'),'拍照／视频');
});
test('lost completion response reconciles only the same saved record, and cancelled tasks provide recovery', () => {
  const link={taskId:'task',completion:{kind:'dailyLog',recordId:'record'}};
  const task={id:'task',status:'completed',completion:{kind:'dailyLog',recordId:'record'}};
  assert.equal(helper.pendingMaintenanceCompletionState([task],link),'resolved');
  assert.equal(helper.pendingMaintenanceCompletionState([{...task,completion:{kind:'dailyLog',recordId:'other'}}],link),'unavailable');
  assert.equal(helper.pendingMaintenanceCompletionState([{...task,status:'cancelled'}],link),'unavailable');
  assert.equal(helper.pendingMaintenanceCompletionState([],link),'unavailable');
  assert.equal(helper.pendingMaintenanceCompletionState([{...task,status:'in_progress',completion:undefined}],link),'retry');
});
