import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
let vite, helper;
before(async () => {
  vite = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] } });
  helper = await vite.ssrLoadModule('/src/app/utils/privateAttachmentMedia.ts');
});
after(async () => { await vite?.close(); });

async function withSession(run) {
  const oldWindow = globalThis.window, oldFetch = globalThis.fetch;
  let session = { username: 'qa-admin', role: 'admin', token: 'synthetic-private-token', expiresAt: Date.now()+60000, visibleSiteIds: [] };
  globalThis.window = { localStorage: { getItem: () => JSON.stringify(session), removeItem: () => { session = null; } } };
  try { await run(value => { session = value; }, session); }
  finally { globalThis.window = oldWindow; globalThis.fetch = oldFetch; }
}

test('personnel preview is authenticated binary GET without download flag; explicit download is separate', async () => withSession(async () => {
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({url, options}); return new Response(new Blob(['image'], {type:'image/png'})); };
  const signal = new AbortController().signal;
  assert.equal((await helper.fetchPersonnelAttachmentImage('private-1', signal)).type, 'image/png');
  assert.equal(calls[0].url, '/api/personnel/attachments/private-1');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer synthetic-private-token');
  assert.equal(calls[0].options.cache, 'no-store');
  assert.equal(calls[0].options.signal, signal);
  await helper.fetchPersonnelAttachmentImage('private-1', signal, true);
  assert.equal(calls[1].url, '/api/personnel/attachments/private-1?download=1');
}));

test('private preview refuses external/invalid IDs, HTML and unauthorised responses', async () => withSession(async () => {
  let count = 0;
  globalThis.fetch = async () => { count++; return new Response('<html/>', {headers:{'Content-Type':'text/html'}}); };
  await assert.rejects(helper.fetchPersonnelAttachmentImage('https://external.invalid/a', new AbortController().signal), /编号/);
  assert.equal(count,0);
  await assert.rejects(helper.fetchPersonnelAttachmentImage('private-1', new AbortController().signal), /可预览/);
  globalThis.fetch = async () => new Response(JSON.stringify({error:'无权查看'}), {status:403});
  await assert.rejects(helper.fetchPersonnelAttachmentImage('private-1', new AbortController().signal), /无权查看/);
}));

test('private session fingerprint changes on identity, token, expiry and site scope; mismatched store user denied', async () => withSession(async (set, session) => {
  const user = {username:'qa-admin',role:'admin',visibleSiteIds:[]};
  const initial = helper.privateMediaSessionKey(user);
  assert.ok(initial);
  assert.equal(helper.privateMediaSessionKey({username:'other',role:'admin'}),'');
  assert.equal(helper.privateMediaSessionKey(null),'');
  for (const patch of [{token:'changed'}, {visibleSiteIds:['nanjing']}, {expiresAt:Date.now()+120000}]) {
    set({...session,...patch}); assert.notEqual(helper.privateMediaSessionKey(user),initial);
  }
  set({...session,expiresAt:Date.now()-1}); assert.equal(helper.privateMediaSessionKey(user),'');
}));

test('private preview cancels and revokes on scope/session/unmount; entry points default to preview', async () => {
  const [preview, people, notifications] = await Promise.all(['PrivatePersonnelAttachmentPreview.tsx','PersonnelView.tsx','NotificationCenter.tsx'].map(name => readFile(new URL(name,import.meta.url),'utf8')));
  assert.match(preview, /pending\.current\?\.abort\(\)/);
  assert.match(preview, /URL\.revokeObjectURL\(urlRef\.current\)/);
  assert.match(preview, /\[scope, session\]/);
  assert.match(preview, /privateMediaSessionKey\(context\.current\.user\) === expectedSession/);
  assert.match(preview, /allowDownload && context\.current\.user\?\.role === "admin"/);
  assert.match(people, /预览核对/); assert.doesNotMatch(people,/下载核对|const downloadAttachment/);
  assert.match(notifications, /在线预览附件/); assert.doesNotMatch(notifications,/下载核对|preview\.target = "_blank"/);
});
