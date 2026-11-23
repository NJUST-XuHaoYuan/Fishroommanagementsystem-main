import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LOCAL_TEST_TITLE, markLocalTestHtml } from "../deploy/local-test/mark-local-test-html.mjs";

const source = await readFile(new URL("./local-server.mjs", import.meta.url), "utf8");
const listenSource = source.slice(source.lastIndexOf("server.listen(port, host, () => {"));

function invokeStartup(flag) {
  const calls = { orders: 0, timers: [], messages: [] };
  new Function("server", "process", "console", "port", "host", "pgConfig", "scheduleAutomaticOrderTransitions", "setInterval",
    "cleanupNewCustomerEvidenceDrafts", "cleanupPaymentEvidenceDrafts", "pool", "stateId", "uploadDir", listenSource)(
    { listen: (_port, _host, callback) => callback() }, { env: { FISHROOM_DISABLE_BACKGROUND_TASKS: flag } },
    { log: message => calls.messages.push(message) }, 8787, "127.0.0.1", { database: "fishroom_test" },
    () => { calls.orders += 1; }, (callback, delay) => { calls.timers.push({ callback, delay }); return { unref() {} }; },
    async () => {}, async () => {}, {}, "main", "/private/local-test-uploads",
  );
  return calls;
}

test("explicit local-test flag starts neither the automatic order scheduler nor evidence cleanup timer", () => {
  const calls = invokeStartup("true"); assert.equal(calls.orders, 0); assert.deepEqual(calls.timers, []);
  assert.ok(calls.messages.some(message => message.includes("已关闭订单自动流转和凭证草稿定时清理")));
});

test("unset or false local-test flag preserves ordinary production scheduling", () => {
  for (const flag of [undefined, "false"]) {
    const calls = invokeStartup(flag); assert.equal(calls.orders, 1); assert.equal(calls.timers.length, 1);
    assert.equal(calls.timers[0].delay, 30 * 60 * 1000);
  }
});

test("local-test HTML title is explicit, idempotent and leaves business markup untouched", () => {
  const html = "<!doctype html><html><head><title>鱼房管理系统</title></head><body><div id=\"root\"></div><script src=\"/assets/app.js\"></script></body></html>";
  const marked = markLocalTestHtml(html); assert.ok(marked.includes(`<title>${LOCAL_TEST_TITLE}</title>`));
  assert.equal(markLocalTestHtml(marked), marked); assert.equal(marked.slice(marked.indexOf("<body>")), html.slice(html.indexOf("<body>")));
});

test("local Compose isolates names, database and network and exposes only a loopback frontend", async () => {
  const compose = await readFile(new URL("../deploy/local-test/compose.yml", import.meta.url), "utf8");
  assert.match(compose, /^name: fishroom-local-test/m);
  for (const role of ["frontend", "backend", "database"]) assert.match(compose, new RegExp(`container_name: fishroom-local-test-${role}`));
  assert.equal((compose.match(/^    ports:/gm) ?? []).length, 1); assert.match(compose, /127\.0\.0\.1:\$\{LOCAL_TEST_PORT:-8787\}:80/);
  assert.match(compose, /name: fishroom-local-test-postgres/); assert.match(compose, /internal: true/);
  const frontend = compose.split("  frontend:")[1].split("  backend:")[0];
  const backend = compose.split("  backend:")[1].split("  database:")[0];
  const database = compose.split("  database:")[1].split("\nvolumes:")[0];
  assert.match(frontend, /networks: \[local-test, local-test-web\]/);
  for (const privateService of [backend, database]) { assert.match(privateService, /networks: \[local-test\]/); assert.doesNotMatch(privateService, /local-test-web/); }
  assert.match(compose, /PGHOST: database/); assert.match(compose, /PGDATABASE: fishroom_test/); assert.match(compose, /DATABASE_URL: ""/);
  for (const credential of ["COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET", "COS_REGION", "FEISHU_WEBHOOK_URL", "FEISHU_APP_SECRET", "WECHAT_MINIPROGRAM_APP_SECRET", "AI_API_KEY", "OPENAI_API_KEY"]) {
    assert.ok(compose.includes(`${credential}: ""`), credential);
  }
  assert.match(compose, /FISHROOM_DISABLE_BACKGROUND_TASKS: "true"/);
});

test("local image version arguments cannot inherit stale release environment from cached base images", async () => {
  for (const role of ["backend", "frontend"]) {
    const dockerfile = await readFile(new URL(`../deploy/local-test/${role}.Dockerfile`, import.meta.url), "utf8");
    assert.match(dockerfile, /ARG LOCAL_TEST_RELEASE_REVISION/);
    assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$LOCAL_TEST_RELEASE_REVISION"/);
    assert.match(dockerfile, /ENV RELEASE_REVISION=\$LOCAL_TEST_RELEASE_REVISION RELEASE_BUILT_AT=\$LOCAL_TEST_RELEASE_BUILT_AT BASE_REVISION=\$LOCAL_TEST_BASE_REVISION/);
  }
});
