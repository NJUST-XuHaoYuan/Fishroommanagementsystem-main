import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CLOUD_TEST_TITLE, markCloudTestHtml } from "./mark-cloud-test-html.mjs";

test("cloud test label survives both build input and repeated packaging without changing application markup", () => {
  const html = '<html><head><title>正式系统</title></head><body><div id="root"></div><script src="/assets/app.js"></script></body></html>';
  const marked = markCloudTestHtml(html);
  assert.equal(markCloudTestHtml(marked), marked);
  assert.match(marked, new RegExp(CLOUD_TEST_TITLE));
  assert.match(marked, /云端测试环境 · 操作不影响正式系统/);
  assert.match(marked, /pointer-events:none/);
  assert.match(marked, /mm-dialog-footer[^}]+18px/);
  assert.equal(marked.slice(marked.indexOf("<body>")), html.slice(html.indexOf("<body>")));
  assert.throws(() => markCloudTestHtml("<body>no head</body>"));
});

test("cloud test config exposes only loopback frontend with isolated names and explicitly blank integrations", async () => {
  const compose = await readFile(new URL("./compose.yml", import.meta.url), "utf8");
  assert.match(compose, /^name: fishroom-cloud-test/m);
  assert.equal((compose.match(/^    ports:/gm) ?? []).length, 1);
  assert.match(compose, /127\.0\.0\.1:8797:80/);
  assert.doesNotMatch(compose, /env_file:/);
  assert.match(compose, /PGDATABASE: fishroom_test/);
  assert.match(compose, /PGUSER: fishroom_test/);
  assert.match(compose, /name: fishroom-cloud-test-postgres/);
  assert.match(compose, /internal: true/);
  assert.match(compose, /FISHROOM_CLOUD_TEST: "true"/);
  assert.match(compose, /FISHROOM_DISABLE_BACKGROUND_TASKS: "true"/);
  for (const key of ["COS_SECRET_ID", "COS_SECRET_KEY", "COS_BUCKET", "FEISHU_WEBHOOK_URL", "FEISHU_APP_SECRET", "WECHAT_MINIPROGRAM_APP_SECRET", "AI_API_KEY", "OPENAI_API_KEY"]) assert.ok(compose.includes(`${key}: ""`), key);
  for (const role of ["backend", "database"]) {
    const section = compose.split(new RegExp(`^  ${role}:$`, "m"))[1].split(/^\S|^  \w+:$/m)[0];
    assert.match(section, /networks: \[cloud-test\]/);
    assert.doesNotMatch(section, /cloud-test-web/);
  }
});

test("cloud ingress has a distinct TLS host and no public-catalog route", async () => {
  const nginx = await readFile(new URL("./nginx.conf", import.meta.url), "utf8");
  assert.match(nginx, /server_name test\.marineforest\.com\.cn;/);
  assert.match(nginx, /127\.0\.0\.1:8797/);
  assert.match(nginx, /location \^~ \/api\/public\/ \{ return 404; \}/);
  assert.match(nginx, /test\.marineforest\.com\.cn\/fullchain\.pem/);
});
