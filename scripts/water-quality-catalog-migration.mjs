import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_WATER_QUALITY_PARAMETERS } from '../server/water-quality-rules.mjs';

// Explicit, one-time catalog update. Never infer measurements from old notes.
export function migrateWaterQualityCatalog(settings = {}) {
  if (Number(settings.waterQualityCatalogVersion || 0) >= 1) return { changed: false, settings };
  const source = Array.isArray(settings.waterQualityParameters)
    ? settings.waterQualityParameters : DEFAULT_WATER_QUALITY_PARAMETERS;
  const parameters = source.map(item => ({
    ...item,
    ...(item.id === 'ammonia' ? { unit: 'PPM' } : {}),
    ...(item.id === 'alkalinity' ? { name: 'KH' } : {}),
    testMethods: Array.isArray(item.testMethods) ? [...item.testMethods] : [],
  }));
  if (!parameters.some(item => item.id === 'orp' || String(item.name).trim().toUpperCase() === 'ORP')) {
    parameters.push({ id: 'orp', name: 'ORP', unit: 'mV', precision: 0, testMethods: [] });
  }
  return { changed: true, settings: { ...settings, waterQualityParameters: parameters, waterQualityCatalogVersion: 1 } };
}

async function main() {
  const args = process.argv.slice(2);
  const expectedDatabase = args.find(arg => arg.startsWith('--database='))?.slice('--database='.length);
  if (!['fishroom', 'fishroom_test'].includes(expectedDatabase)) throw new Error('Specify --database=fishroom or --database=fishroom_test');
  const apply = args.includes('--apply');
  const { default: pg } = await import('pg');
  const client = new pg.Client();
  await client.connect();
  try {
    const identity = (await client.query('SELECT current_database() AS db')).rows[0];
    if (identity.db !== expectedDatabase) throw new Error('Database identity mismatch');
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    const row = (await client.query("SELECT data->'systemSettings' AS settings FROM app_state WHERE id='main' FOR UPDATE")).rows[0];
    if (!row) throw new Error('Main state missing');
    const result = migrateWaterQualityCatalog(row.settings || {});
    const fingerprint = async () => (await client.query("SELECT md5(COALESCE(data->'waterQualityRecords','[]'::jsonb)::text) AS water, md5(COALESCE(data->'logs','[]'::jsonb)::text) AS logs FROM app_state WHERE id='main'")).rows[0];
    const before = await fingerprint();
    if (apply && result.changed) {
      const operation = { id: randomUUID(), time: new Date().toISOString(), operator: '系统升级', module: '后台管理', action: '修改记录',
        detail: '氨氮单位设为 PPM，碱度显示为 KH，新增 ORP（mV）；保留自定义参数及全部历史记录。' };
      await client.query("UPDATE app_state SET data=jsonb_set(jsonb_set(data,'{systemSettings}',$1::jsonb,true),'{operationLogs}',$2::jsonb || COALESCE(data->'operationLogs','[]'::jsonb),true),updated_at=now() WHERE id='main'",
        [JSON.stringify(result.settings), JSON.stringify([operation])]);
    }
    const after = await fingerprint();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Historical record fingerprint changed');
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ database: identity.db, applied: apply && result.changed, pendingChange: result.changed && !apply,
      parameters: result.settings.waterQualityParameters.map(({ id, name, unit }) => ({ id, name, unit })), historicalRecordsUnchanged: true, fingerprints: after }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { await client.end(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
