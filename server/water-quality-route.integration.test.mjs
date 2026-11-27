import test from 'node:test';
import assert from 'node:assert/strict';
import { startMutableRouteServer } from './test-support/mutable-route-server.mjs';
import { stockPricingFixture, PRICING_TEST_PASSWORD } from './test-support/stock-pricing-fixture.mjs';
const ok = r => assert.equal(r.response.status, 200, JSON.stringify(r.body));
const denied = r => assert.ok(r.response.status >= 400 && r.response.status < 500, JSON.stringify(r.body));
const parameters = [
  { id: 'ph', name: 'pH', unit: 'pH', precision: 2, testMethods: ['测试笔', '试剂'] },
  { id: 'orp', name: 'ORP', unit: 'mV', precision: 0, testMethods: ['仪器'] },
  { id: 'ammonia', name: '氨氮', unit: 'PPM', precision: 3, testMethods: [] },
  { id: 'copper', name: '铜', unit: 'mg/L', precision: 3, testMethods: [] },
];
const record = (id, extra = {}) => ({ id, measuredAt: '2026-11-01T02:00:00Z', siteId: 'nanjing', tankGroupId: 'group-n', subTankId: 'tank-n',
  values: [{ parameterId: 'ph', value: '8.12', testMethod: '测试笔' }], photos: ['/uploads/water.jpg'], videos: ['/uploads/water.mp4'], notes: '合成水质测量', operator: 'forged', createdBy: 'forged', ...extra });
async function setup(t, mutate = () => {}) {
  const fixture = structuredClone(stockPricingFixture);
  fixture.state.systemSettings = { waterQualityParameters: structuredClone(parameters), unrelatedSetting: 'keep' };
  fixture.state.tankGroups[0].waterQualityParameterIds = ['ph']; fixture.state.tankGroups[0].subTanks.push({ id: 'tank-n2', name: 'N2' });
  fixture.state.waterQualityRecords = [];
  fixture.state.logs = [{ id: 'legacy-water-text', siteId: 'nanjing', tankGroupId: 'group-n', subTankId: 'tank-n', date: '2026-11-01T09:00:00', action: '测水质', notes: '盐度35，其他文字不能解析', operator: 'pricing-editor' }];
  mutate(fixture.state);
  const server = await startMutableRouteServer(fixture); t.after(server.stop);
  const tokens = {};
  for (const name of ['admin', 'editor', 'viewer']) tokens[name] = await server.login(`pricing-${name}`, PRICING_TEST_PASSWORD);
  const request = (path, body, actor = 'editor') => server.request(path, { token: tokens[actor], ...(body === undefined ? {} : { body }) });
  return { ...server, tokens, request,
    save: (r, actor = 'editor', extra = {}) => request('/api/water-quality-records/save', { record: r, createOnly: true, ...extra }, actor),
    history: (query = '', actor = 'editor') => request(`/api/mobile-maintenance/history?siteId=nanjing${query}`, undefined, actor) };
}

test('mobile saves signed structured parameter snapshots, media and sub-tank without rewriting old text or fish histories', async t => {
  const s = await setup(t); const before = await s.readPersistedState();
  const result = await s.save(record('water')); ok(result); const r = result.body.changedRecord;
  assert.equal(result.body.siteId, 'nanjing'); assert.equal(result.body.tankGroupId, 'group-n'); assert.equal(result.body.waterQualityRecords, undefined);
  assert.equal(r.operator, 'pricing-editor'); assert.equal(r.createdBy, 'pricing-editor'); assert.equal(r.subTankId, 'tank-n');
  assert.deepEqual(r.values, [{ parameterId: 'ph', value: 8.12, parameterName: 'pH', unit: 'pH', precision: 2, testMethod: '测试笔' }]);
  assert.deepEqual(r.photos, ['/uploads/water.jpg']); assert.deepEqual(r.videos, ['/uploads/water.mp4']);
  const after = await s.readPersistedState(); assert.deepEqual(after.logs, before.logs); assert.deepEqual(after.bioRecords, before.bioRecords);
  assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.systemSettings, before.systemSettings);
  const all = await s.history('&subTankId=tank-n'); ok(all); assert.equal(all.body.waterQualityRecords[0].id, 'water'); assert.equal(all.body.logs[0].id, 'legacy-water-text');
});

test('all configured parameters are selectable, zero and negative ORP work; unknown methods and blank values are rejected', async t => {
  const s = await setup(t);
  ok(await s.save(record('orp', { values: [{ parameterId: 'orp', value: -100, testMethod: '仪器' }] })));
  ok(await s.save(record('copper', { values: [{ parameterId: 'copper', value: 0 }] })));
  const before = await s.readPersistedState();
  for (const value of ['', ' ', null, 'NaN', true, [], {}, 'Infinity']) denied(await s.save(record('invalid', { values: [{ parameterId: 'ph', value }] })));
  denied(await s.save(record('invalid', { values: [{ parameterId: 'ph', value: 8.1, testMethod: '伪造试剂' }] })));
  denied(await s.save(record('invalid', { values: [{ parameterId: 'not-configured', value: 1 }] })));
  denied(await s.save(record('invalid', { photos: ['javascript:alert(1)'] })));
  assert.deepEqual(await s.readPersistedState(), before);
});

test('create-only retry uses create permission, checks original author/content and remains atomic under concurrency', async t => {
  const s = await setup(t); await s.patchTestPersonnel('pricing-editor', { permissions: { daily: { create: true, update: false, delete: false } } });
  const responses = await Promise.all([s.save(record('retry')), s.save(record('retry'))]); responses.forEach(ok);
  assert.equal(responses.filter(r => r.body.idempotent).length, 1); assert.equal((await s.readPersistedState()).waterQualityRecords.length, 1);
  assert.equal((await s.save(record('retry', { notes: 'changed' }))).response.status, 409);
  assert.equal((await s.save(record('retry'), 'admin')).response.status, 409);
  assert.equal((await s.save(record('retry'), 'editor', { createOnly: false })).response.status, 403);
  denied(await s.save(record('', {})));
});

test('create-only retry accepts jsonb-reordered measurement keys but rejects changed values and array order', async t => {
  const input = record('jsonb-retry', {
    values: [{ parameterId: 'ph', value: '8.12', testMethod: '测试笔' }, { parameterId: 'orp', value: -100, testMethod: '仪器' }],
    photos: ['/uploads/first.jpg', '/uploads/second.jpg'],
  });
  // Seed a committed row as jsonb would return it: object key order differs
  // from the normalizer's insertion order, but array order stays unchanged.
  const persistedValues = [
    { unit: 'pH', value: 8.12, precision: 2, testMethod: '测试笔', parameterId: 'ph', parameterName: 'pH' },
    { unit: 'mV', value: -100, precision: 0, testMethod: '仪器', parameterId: 'orp', parameterName: 'ORP' },
  ];
  const s = await setup(t, state => {
    state.waterQualityRecords = [{ ...input, values: persistedValues, measuredAt: '2026-11-01T02:00:00.000Z', operator: 'pricing-editor', createdBy: 'pricing-editor' }];
  });
  const before = await s.readPersistedState();
  const retry = await s.save(input); ok(retry); assert.equal(retry.body.idempotent, true);
  assert.deepEqual(retry.body.changedRecord.values, persistedValues);
  assert.equal((await s.save({ ...input, values: [...input.values].reverse() })).response.status, 409);
  assert.equal((await s.save({ ...input, values: [{ ...input.values[0], value: 8.13 }, input.values[1]] })).response.status, 409);
  assert.equal((await s.save({ ...input, photos: [...input.photos].reverse() })).response.status, 409);
  assert.deepEqual(await s.readPersistedState(), before);
});

test('sub-tank ownership, site authorization and live account revocation are enforced before writes', async t => {
  const s = await setup(t); const before = await s.readPersistedState();
  assert.equal((await s.save(record('wrong-tank', { subTankId: 'tank-j' }))).response.status, 404);
  assert.equal((await s.save(record('cross', { siteId: 'jiangyin', tankGroupId: 'group-j', subTankId: 'tank-j' }))).response.status, 403);
  assert.equal((await s.save(record('spoof', { siteId: 'jiangyin' }))).response.status, 409);
  assert.equal((await s.save(record('viewer'), 'viewer')).response.status, 403);
  assert.deepEqual(await s.readPersistedState(), before);
  await s.patchTestPersonnel('pricing-editor', { accountEnabled: false }); denied(await s.save(record('disabled')));
  assert.equal((await s.readPersistedState()).waterQualityRecords.length, 0);
});

test('administrator configuration preserves custom parameters and historical snapshots; stale editors retain scope, media and creator', async t => {
  const s = await setup(t); ok(await s.save(record('old')));
  const before = await s.readPersistedState(); const params = parameters.map(p => p.id === 'ph' ? { ...p, name: '新pH名称', unit: '新版单位', precision: 1, testMethods: ['新仪器'] } : p);
  denied(await s.request('/api/water-quality/settings/save', { parameters: params }));
  ok(await s.request('/api/water-quality/settings/save', { parameters: params, assignments: [{ groupId: 'group-n', parameterIds: ['orp'] }] }, 'admin'));
  assert.deepEqual((await s.readPersistedState()).waterQualityRecords, before.waterQualityRecords);
  const old = before.waterQualityRecords[0];
  const edited = await s.save({ id: old.id, tankGroupId: old.tankGroupId, measuredAt: old.measuredAt, values: [{ parameterId: 'ph', value: 8.345, parameterName: 'forged', unit: 'fake' }], notes: '备注修正' }, 'admin', { createOnly: false }); ok(edited);
  assert.deepEqual(edited.body.changedRecord.values[0], { ...old.values[0], value: 8.35 });
  assert.equal(edited.body.changedRecord.createdBy, 'pricing-editor'); assert.equal(edited.body.changedRecord.operator, 'pricing-admin');
  assert.equal(edited.body.changedRecord.subTankId, 'tank-n'); assert.deepEqual(edited.body.changedRecord.photos, old.photos);
  const newer = await s.save(record('new', { values: [{ parameterId: 'ph', value: 8.345, testMethod: '新仪器' }] })); ok(newer);
  assert.equal(newer.body.changedRecord.values[0].parameterName, '新pH名称'); assert.equal(newer.body.changedRecord.values[0].unit, '新版单位'); assert.equal(newer.body.changedRecord.values[0].precision, 1);
  const state = await s.readPersistedState(); assert.equal(state.systemSettings.unrelatedSetting, 'keep'); assert(state.systemSettings.waterQualityParameters.some(p => p.id === 'copper'));
  assert.deepEqual(state.logs, before.logs);
  assert.equal((await s.save({ ...edited.body.changedRecord, subTankId: 'tank-n2' }, 'admin', { createOnly: false })).response.status, 409);
});

test('personal history mixes chronological water/tank/fish records and does not leak other users, sub-tanks or sites', async t => {
  const s = await setup(t, state => {
    state.bioRecords = [{ id: 'bio-own', stockItemId: 'follower', siteId: 'nanjing', subTankId: 'tank-n', date: '2026-11-01T09:30:00', operator: 'pricing-editor', sourceType: 'manual' }];
  });
  ok(await s.save(record('water-own'))); ok(await s.save(record('water-other'), 'admin'));
  ok(await s.save(record('water-sub2', { subTankId: 'tank-n2' })));
  ok(await s.save(record('water-private', { siteId: 'jiangyin', tankGroupId: 'group-j', subTankId: 'tank-j' }), 'admin'));
  const h = await s.history('&subTankId=tank-n&limit=1'); ok(h); assert.equal(h.body.waterQualityRecords[0].id, 'water-own'); assert.equal(h.body.logs.length + h.body.bioRecords.length, 0); assert.equal(h.body.truncated, true);
  const all = await s.history('&subTankId=tank-n'); ok(all); assert.deepEqual(all.body.waterQualityRecords.map(r => r.id), ['water-own']);
  assert.deepEqual(all.body.bioRecords.map(r => r.id), ['bio-own']); assert.deepEqual(all.body.logs.map(r => r.id), ['legacy-water-text']);
  const sub2 = await s.history('&subTankId=tank-n2'); ok(sub2); assert.deepEqual(sub2.body.waterQualityRecords.map(r => r.id), ['water-sub2']);
  assert.equal((await s.history('&subTankId=tank-j')).response.status, 404);
});

test('deletion responds with a scoped id only and generic state writes cannot forge water history', async t => {
  const s = await setup(t); ok(await s.save(record('delete'))); const before = await s.readPersistedState();
  for (const records of [[], [{ ...before.waterQualityRecords[0], operator: 'forged', values: [] }]]) denied(await s.request('/api/state/patch', { patch: { waterQualityRecords: records }, basePatch: { waterQualityRecords: before.waterQualityRecords } }, 'admin'));
  assert.deepEqual(await s.readPersistedState(), before);
  const deleted = await s.request('/api/water-quality-records/save', { deleteId: 'delete' }, 'admin'); ok(deleted);
  assert.equal(deleted.body.deletedRecordId, 'delete'); assert.equal(deleted.body.siteId, 'nanjing'); assert.equal(deleted.body.waterQualityRecords, undefined);
  const after = await s.readPersistedState(); assert.equal(after.waterQualityRecords.length, 0); assert.deepEqual(after.logs, before.logs);
});

test('malformed historical timestamps remain readable and sort after valid measurements', async t => {
  const s = await setup(t, state => { state.waterQualityRecords = [{ ...record('legacy-invalid'), operator: 'pricing-editor', createdBy: 'pricing-editor', measuredAt: '旧表日期未填写' }]; });
  ok(await s.save(record('valid')));
  const bounded = await s.history('&subTankId=tank-n&limit=1'); ok(bounded); assert.equal(bounded.body.waterQualityRecords[0].id, 'valid');
  const all = await s.history('&subTankId=tank-n'); ok(all); assert.deepEqual(all.body.waterQualityRecords.map(r => r.id), ['valid', 'legacy-invalid']);
});

test('generic settings writes cannot bypass parameter validation and unchanged normalized catalog permits unrelated setting edits', async t => {
  const s = await setup(t); const before = await s.readPersistedState();
  denied(await s.request('/api/state/patch', { patch: { systemSettings: { ...before.systemSettings, waterQualityParameters: [{ ...parameters[0], testMethods: ['forged'] }] } }, basePatch: { systemSettings: before.systemSettings } }, 'admin'));
  const unchanged = await s.request('/api/state/patch', { patch: { systemSettings: { ...before.systemSettings, unrelatedSetting: 'changed' } }, basePatch: { systemSettings: before.systemSettings } }, 'admin'); ok(unchanged);
  const after = await s.readPersistedState(); assert.deepEqual(after.systemSettings.waterQualityParameters, before.systemSettings.waterQualityParameters); assert.equal(after.systemSettings.unrelatedSetting, 'changed');
});

test('generic settings omission or forged migration version cannot erase the water catalog or its migration marker', async t => {
  const s = await setup(t, state => { state.systemSettings.waterQualityCatalogVersion = 1; });
  const before = await s.readPersistedState();
  for (const settings of [{ unrelatedSetting: 'first' }, { unrelatedSetting: 'second', waterQualityCatalogVersion: 0 }]) {
    ok(await s.request('/api/state/patch', { patch: { systemSettings: settings }, basePatch: { systemSettings: before.systemSettings } }, 'admin'));
    const after = await s.readPersistedState();
    assert.deepEqual(after.systemSettings.waterQualityParameters, before.systemSettings.waterQualityParameters);
    assert.equal(after.systemSettings.waterQualityCatalogVersion, 1);
    assert.equal(after.systemSettings.unrelatedSetting, settings.unrelatedSetting);
    assert.deepEqual(after.waterQualityRecords, before.waterQualityRecords);
    assert.deepEqual(after.logs, before.logs);
  }
  const current = await s.readPersistedState();
  const staleCatalog = current.systemSettings.waterQualityParameters.map(({ testMethods, ...parameter }) => parameter);
  const rejected = await s.request('/api/state/patch', { patch: { systemSettings: { ...current.systemSettings, waterQualityParameters: staleCatalog } } }, 'admin');
  assert.equal(rejected.response.status, 409);
  assert.deepEqual(await s.readPersistedState(), current);
});

test('legacy clients omitting empty test methods may save other settings without rewriting the stored catalog', async t => {
  const s = await setup(t, state => {
    state.systemSettings.waterQualityCatalogVersion = 1;
    state.systemSettings.waterQualityParameters = parameters.map(parameter => ({ ...parameter, testMethods: [] }));
  });
  const before = await s.readPersistedState();
  const legacyCatalog = before.systemSettings.waterQualityParameters.map(({ testMethods, ...parameter }) => parameter);
  ok(await s.request('/api/state/patch', { patch: { systemSettings: { unrelatedSetting: 'legacy client saved', waterQualityParameters: legacyCatalog } } }, 'admin'));
  const after = await s.readPersistedState();
  assert.deepEqual(after.systemSettings.waterQualityParameters, before.systemSettings.waterQualityParameters);
  assert.equal(after.systemSettings.waterQualityCatalogVersion, 1);
  assert.equal(after.systemSettings.unrelatedSetting, 'legacy client saved');
});
