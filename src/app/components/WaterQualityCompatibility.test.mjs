import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite, store, panel, settings;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] }, esbuild: { jsx: 'automatic' } });
  store = await vite.ssrLoadModule('/src/app/store.ts');
  panel = await vite.ssrLoadModule('/src/app/components/WaterQualityRecordsPanel.tsx');
  settings = await vite.ssrLoadModule('/src/app/components/WaterQualitySettingsView.tsx');
});
after(async () => { await vite?.close(); });
const record = (id, extra = {}) => ({ id, siteId: 'nanjing', tankGroupId: 'group', measuredAt: '2026-11-27T12:00:00', operator: 'tester', notes: '', values: [], ...extra });

test('new defaults contain 12 requested parameters without inventing methods', () => {
  const values = store.normalizeWaterQualityParameters();
  assert.equal(values.length, 12);
  assert.deepEqual(values.map(p => p.name), ['盐度', '温度', 'pH', '溶解氧', 'ORP', '氨氮', '亚硝酸盐', '硝酸盐', '钙', '镁', 'KH', '磷酸盐']);
  assert.equal(values.find(p => p.id === 'ammonia').unit, 'PPM');
  assert.equal(values.find(p => p.id === 'orp').unit, 'mV');
  assert.ok(values.every(p => Array.isArray(p.testMethods) && p.testMethods.length === 0));
});

test('normalization retains custom and historical configuration without auto-migrating it', () => {
  const values = store.normalizeWaterQualityParameters({ waterQualityParameters: [
    { id: 'ammonia', name: '旧氨氮', unit: 'mg/L', precision: 3 },
    { id: 'custom-copper', name: '铜', unit: 'mg/L', precision: 3, testMethods: ['  方法甲  ', '', '方法乙'] },
  ] });
  assert.equal(values.length, 2);
  assert.equal(values[0].name, '旧氨氮'); assert.equal(values[0].unit, 'mg/L');
  assert.deepEqual(values[0].testMethods, []);
  assert.deepEqual(values[1].testMethods, ['方法甲', '方法乙']);
  assert.deepEqual(store.normalizeWaterQualityParameters({ waterQualityParameters: [] }), []);
});

test('method configuration rejects duplicate, oversized and excessive entries but permits empty', () => {
  assert.equal(store.waterQualityTestMethodsError([]), '');
  assert.equal(store.waterQualityTestMethodsError([' ', '方法甲']), '');
  assert.match(store.waterQualityTestMethodsError(['ABC', ' abc ']), /重复/);
  assert.match(store.waterQualityTestMethodsError(['甲'.repeat(81)]), /80/);
  assert.match(store.waterQualityTestMethodsError(Array.from({ length: 21 }, (_, i) => String(i))), /20/);
});

test('editing snapshots win over renamed config and keep removed parameters and old methods', () => {
  const original = record('old', { values: [
    { parameterId: 'ammonia', parameterName: '氨氮', value: 0.2, unit: 'mg/L', precision: 3, testMethod: '原方法' },
    { parameterId: 'removed', parameterName: '已删除项目', value: 3, unit: '旧单位', precision: 1 },
  ] });
  const result = panel.waterQualityDraftParameters([{ id: 'ammonia', name: '新名称', unit: 'PPM', precision: 1, testMethods: ['新方法'] }], ['ammonia'], original);
  assert.deepEqual(result[0], { id: 'ammonia', name: '氨氮', unit: 'mg/L', precision: 3, testMethods: ['新方法', '原方法'] });
  assert.equal(result[1].id, 'removed'); assert.equal(result[1].unit, '旧单位');
  assert.deepEqual(result[1].testMethods, []);
  assert.match(panel.formatMeasurement(original.values[0]), /0\.200 mg\/L · 原方法/);
});

test('incremental save retains other sites and sub-tanks without duplicating IDs', () => {
  const current = [record('one'), record('two', { subTankId: 'other-sub' }), record('other-site', { siteId: 'jiangyin' })];
  const changedRecord = record('one', { subTankId: 'sub-one', photos: ['/uploads/photo.jpg'], videos: ['/uploads/video.mp4'], createdBy: 'original' });
  const result = store.mergeWaterQualityRecordSave(current, { changedRecord }, { record: changedRecord });
  assert.equal(result.length, 3); assert.deepEqual(result[0], changedRecord);
  assert.strictEqual(result[1], current[1]); assert.strictEqual(result[2], current[2]);
  assert.deepEqual(store.mergeWaterQualityRecordSave(result, { changedRecord }, { record: changedRecord }), result);
});

test('legacy scoped save responses only update the requested record and do not erase a partial history', () => {
  const current = [record('one'), record('same-site-other'), record('other-site', { siteId: 'jiangyin' })];
  const edited = record('one', { notes: 'changed' });
  const result = store.mergeWaterQualityRecordSave(current, { waterQualityRecords: [edited] }, { record: edited });
  assert.deepEqual(result.map(p => p.id), ['one', 'same-site-other', 'other-site']);
  assert.equal(result[0].notes, 'changed');
  assert.deepEqual(store.mergeWaterQualityRecordSave(current, { waterQualityRecords: [] }, { deleteId: 'one' }), current.slice(1));
  assert.deepEqual(store.mergeWaterQualityRecordSave(current, { deletedRecordId: 'one' }, { deleteId: 'one' }), current.slice(1));
  assert.strictEqual(store.mergeWaterQualityRecordSave(current, { changedRecord: record('wrong') }, { record: edited }), current);
});

test('PC history labels the sub-tank, historical method and attachment previews; settings are admin-only', () => {
  const state = { ...store.initialState, user: { username: 'reviewer', role: 'admin' },
    tankGroups: [{ id: 'group', name: '鱼D', location: '', subTanks: [{ id: 'sub', name: 'D2-2' }] }],
    waterQualityRecords: [record('one', { subTankId: 'sub', photos: ['/uploads/photo.jpg'], values: [{ parameterId: 'ammonia', parameterName: '旧氨氮', value: 0.2, unit: 'mg/L', precision: 3, testMethod: '历史方法' }] })] };
  const value = { ...store.StoreContext._currentValue, state, activeSiteId: 'nanjing' };
  const html = renderToStaticMarkup(createElement(store.StoreContext.Provider, { value }, createElement(panel.WaterQualityRecordsPanel)));
  for (const pattern of [/鱼D \/ D2-2/, /旧氨氮/, /0\.200/, /mg\/L/, /历史方法/, /预览水质照片 1/]) assert.match(html, pattern);
  const denied = renderToStaticMarkup(createElement(store.StoreContext.Provider, { value: { ...value, state: { ...state, user: { username: 'staff', role: 'staff' } } } }, createElement(settings.WaterQualitySettingsView)));
  assert.match(denied, /无权访问/); assert.doesNotMatch(denied, /保存配置/);
  const admin = renderToStaticMarkup(createElement(store.StoreContext.Provider, { value }, createElement(settings.WaterQualitySettingsView)));
  assert.match(admin, /可选测试方法/); assert.match(admin, /删除参数也会保留历史记录/);
});
