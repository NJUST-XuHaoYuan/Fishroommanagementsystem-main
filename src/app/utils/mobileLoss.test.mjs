import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";
let vite, loss;
before(async () => {
  vite = await createServer({ configFile: false, cacheDir: ".data/mobile-loss-test-cache", server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, entries: [] } });
  loss = await vite.ssrLoadModule("/src/app/utils/mobileLoss.ts");
});
after(async () => { await vite?.close(); });
const item = (id, extra = {}) => ({ id, subTankId: "sub-a", status: "healthy", lost: false, inDate: "2026-11-01", ...extra });
const freeze = items => loss.freezeMobileLossItems(items, "sub-a", new Set(["out"]), fish => fish.id, () => "photo");
test("loss selection is restricted to the current physical sub-tank", () => {
  const rows = freeze([item("active"), item("out"), item("dead", { lost: true }), item("moving", { tankTransfer: { id: "t", status: "in_transit" } }), item("other", { subTankId: "sub-b" })]);
  assert.deepEqual(rows.map(row => row.expected.id), ["active"]);
});
test("stock CAS is frozen before photography and not changed by later store mutations", () => {
  const stock = item("fish", { tankTransfer: { id: "old", status: "received" } });
  const rows = freeze([stock]);
  stock.subTankId = "sub-b"; stock.status = "sick"; stock.lost = true; stock.tankTransfer.id = "new";
  assert.deepEqual(rows[0].expected, { id: "fish", subTankId: "sub-a", status: "healthy", lost: false, tankTransferId: "old" });
});
test("submitted payload is detached from the editable draft and preserves the retry id", () => {
  const rows = freeze([item("fish")]), photos = ["/photo-a"];
  const request = loss.mobileLossRequest("fixed-id", rows, "2026-11-28", "  ", photos);
  rows[0].expected.status = "sick"; photos.push("/photo-b");
  assert.equal(request.clientMutationId, "fixed-id");
  assert.equal(request.expectedItems[0].status, "healthy");
  assert.deepEqual(request.lossProof, ["/photo-a"]);
  assert.equal(request.lossReason, "");
});
test("photos are required while the reason can be recorded later", () => {
  const rows = freeze([item("fish")]);
  assert.match(loss.mobileLossValidation(rows, "2026-11-28", "2026-11-28", []), /照片/);
  assert.equal(loss.mobileLossValidation(rows, "2026-11-28", "2026-11-28", ["/photo"]), "");
  assert.match(loss.mobileLossValidation([], "2026-11-28", "2026-11-28", ["/photo"]), /选择/);
});
test("batch loss date cannot predate the latest arrival or be in the future", () => {
  const rows = freeze([item("fish"), item("new", { inDate: "2026-11-20" })]);
  assert.match(loss.mobileLossValidation(rows, "2026-11-19", "2026-11-28", ["/photo"]), /2026-11-20/);
  assert.match(loss.mobileLossValidation(rows, "2026-11-29", "2026-11-28", ["/photo"]), /晚于/);
});
