import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Optional SQL integration against a caller-selected disposable Postgres container.
// Every write targets a transaction-local TEMP app_state shadow, never application data.
const source = readFileSync(new URL('./local-server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('if (url.pathname === "/api/water-quality-records/save"');
const end = source.indexOf('if (url.pathname === "/api/products/delete"', start);
const route = source.slice(start, end);
const projection = route.match(/`(SELECT data -> 'sites'[\s\S]*?matching_water_records[\s\S]*?FROM app_state WHERE id = \$1)`/)[1];
const mutation = route.match(/`(UPDATE app_state SET data = jsonb_set\(data, '\{waterQualityRecords\}'[\s\S]*?WHERE id = \$1)`/)[1];
const audit = route.match(/`(UPDATE app_state SET data = jsonb_set\(data, '\{operationLogs\}'[\s\S]*?WHERE id = \$1)`/)[1];
const historySource = readFileSync(new URL('./mobile-maintenance-history.mjs', import.meta.url), 'utf8');
const history = historySource.match(/`(WITH source AS MATERIALIZED[\s\S]*?WHERE record_rank <= \$5)`/)[1];
const literal = value => `'${String(value).replaceAll("'", "''")}'`;

test('water save projects target, keeps unrelated large arrays and appends one bounded audit', () => {
  assert.doesNotMatch(route, /SELECT\s+data\s+FROM\s+app_state/i);
  assert.doesNotMatch(route, /JSON\.stringify\((?:state|nextState|nextRecords|operationLogs)\)/);
  assert(route.indexOf('SELECT 1 FROM app_state WHERE id = $1 FOR UPDATE') < route.indexOf('matching_water_records'));
  assert.equal((mutation.match(/jsonb_set\(/g) || []).length, 1);
  assert.equal((audit.match(/jsonb_set\(/g) || []).length, 1);
  assert.doesNotMatch(projection, /data\s*->\s*'(?:logs|bioRecords|waterQualityRecords|operationLogs)'\s+AS/);
  assert.doesNotMatch(history, /::timestamptz/);
  assert.match(history, /PARTITION BY kind/);
  assert.match(history, /WHERE record_rank <= \$5/);
});

test('real PostgreSQL executes locked target projection, create/update/delete and bounded three-kind history', {
  skip: !process.env.FISHROOM_TEST_POSTGRES_CONTAINER,
}, () => {
  const base = { sites: [{ id: 'nanjing' }], tankGroups: [{ id: 'g', siteId: 'nanjing', subTanks: [{ id: 's' }] }], personnel: [{ id: 'u' }],
    systemSettings: { untouched: true }, stock: [{ id: 'f', siteId: 'nanjing', subTankId: 's' }],
    waterQualityRecords: [{ id: 'foreign', siteId: 'jiangyin', tankGroupId: 'other', operator: 'other', measuredAt: '2026-11-27T01:00:00Z', values: [] }],
    logs: [{ id: 'old-text', siteId: 'nanjing', subTankId: 's', operator: 'u', date: '2026-11-27T08:00:00', notes: '旧水质纯文本，保留' }],
    bioRecords: [{ id: 'bio', stockItemId: 'f', operator: 'u', date: '2026-11-27T08:30:00', text: 'keep' }], operationLogs: [{ id: 'old-audit' }] };
  const record = { id: 'water', siteId: 'nanjing', tankGroupId: 'g', subTankId: 's', operator: 'u', createdBy: 'u', measuredAt: '2026-11-27T01:00:00Z',
    values: [{ parameterId: 'orp', parameterName: 'ORP', unit: 'mV', precision: 0, value: -10, testMethod: '仪器' }], photos: [], videos: [] };
  const changed = { ...record, notes: 'changed' };
  const sql = `BEGIN;
    CREATE TEMP TABLE app_state (id text PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz DEFAULT now()) ON COMMIT DROP;
    INSERT INTO app_state (id,data) VALUES ('test', ${literal(JSON.stringify(base))}::jsonb);
    SELECT 1 FROM app_state WHERE id='test' FOR UPDATE;
    PREPARE water_read(text,text) AS ${projection};
    PREPARE water_mutation(text,text,jsonb,text) AS ${mutation};
    PREPARE water_audit(text,jsonb,integer) AS ${audit};
    PREPARE own_history(text,text,text,text,integer) AS ${history};
    EXECUTE water_mutation('test','water',${literal(JSON.stringify(record))}::jsonb,'create');
    EXECUTE water_read('test','water');
    EXECUTE water_mutation('test','water',${literal(JSON.stringify(changed))}::jsonb,'update');
    EXECUTE water_audit('test','{"id":"water-audit"}'::jsonb,5);
    EXECUTE own_history('test','u','nanjing','s',2);
    SELECT jsonb_build_object('marker','before_delete','data',data) FROM app_state WHERE id='test';
    EXECUTE water_mutation('test','water','null'::jsonb,'delete');
    SELECT jsonb_build_object('marker','after_delete','data',data) FROM app_state WHERE id='test';
    ROLLBACK;`;
  const output = String(execFileSync('docker', ['exec', '-i', process.env.FISHROOM_TEST_POSTGRES_CONTAINER, 'sh', '-c',
    'psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], { input: sql }));
  const parsed = output.split('\n').filter(line => line.startsWith('{') && line.includes('"marker"')).map(line => JSON.parse(line));
  const before = parsed.find(row => row.marker === 'before_delete').data;
  const after = parsed.find(row => row.marker === 'after_delete').data;
  assert.deepEqual(before.waterQualityRecords, [base.waterQualityRecords[0], changed]);
  assert.deepEqual(after.waterQualityRecords, base.waterQualityRecords);
  for (const key of ['logs', 'bioRecords', 'stock', 'systemSettings', 'personnel', 'tankGroups']) assert.deepEqual(after[key], base[key]);
  assert.deepEqual(after.operationLogs, [{ id: 'water-audit' }, { id: 'old-audit' }]);
  for (const kind of ['water', 'tank', 'fish']) assert(output.split('\n').some(line => line.startsWith(`${kind}|`)), `${kind} returned by real history SQL`);
});
