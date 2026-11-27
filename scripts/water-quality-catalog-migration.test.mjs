import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateWaterQualityCatalog } from './water-quality-catalog-migration.mjs';

test('catalog update preserves custom parameters, methods and unrelated settings without mutating source', () => {
  const original = { other: { keep: true }, waterQualityParameters: [
    { id: 'ammonia', name: '氨氮', unit: 'mg/L', precision: 3 },
    { id: 'alkalinity', name: '碱度', unit: 'dKH', precision: 1 },
    { id: 'custom-copper', name: '铜', unit: 'mg/L', precision: 3, testMethods: ['光度计'] },
  ] };
  const before = structuredClone(original);
  const { settings } = migrateWaterQualityCatalog(original);
  assert.deepEqual(original, before);
  assert.equal(settings.waterQualityParameters.length, 4);
  assert.equal(settings.waterQualityParameters[0].unit, 'PPM');
  assert.equal(settings.waterQualityParameters[1].name, 'KH');
  assert.equal(settings.waterQualityParameters[1].unit, 'dKH');
  assert.deepEqual(settings.waterQualityParameters[2], original.waterQualityParameters[2]);
  assert.deepEqual(settings.other, original.other);
  assert.deepEqual(settings.waterQualityParameters[3], { id: 'orp', name: 'ORP', unit: 'mV', precision: 0, testMethods: [] });
});

test('one-time migration does not resurrect parameters deleted after upgrade', () => {
  const first = migrateWaterQualityCatalog({ waterQualityParameters: [] }).settings;
  first.waterQualityParameters = [];
  const second = migrateWaterQualityCatalog(first);
  assert.equal(second.changed, false);
  assert.deepEqual(second.settings.waterQualityParameters, []);
});

test('existing custom ORP remains one parameter and keeps its settings', () => {
  const orp = { id: 'custom-orp', name: 'ORP', unit: 'mV', precision: 1, testMethods: ['电极'] };
  const { settings } = migrateWaterQualityCatalog({ waterQualityParameters: [orp] });
  assert.deepEqual(settings.waterQualityParameters, [orp]);
});
