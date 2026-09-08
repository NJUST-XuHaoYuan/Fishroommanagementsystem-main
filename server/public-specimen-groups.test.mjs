import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { PUBLIC_SPECIMEN_HISTORY_SQL, publicSpecimenGroupKeys } from "./public-specimen-groups.mjs";

const secret = "group-test-only-secret";
const fish = {
  id: "one", productId: "product", siteId: "nanjing", batchId: "batch",
  subTankId: "tank", inDate: "2026-08-01", status: "feeding", basePrice: 100,
  notes: "private note", code: "189",
};
const stock = [fish, { ...fish, id: "two", code: "190" }];

test("identical full-history digests share a private fingerprint despite different stock IDs and codes", () => {
  const digests = { one: "same-history", two: "same-history" };
  const before = JSON.stringify({ stock, digests });
  const keys = publicSpecimenGroupKeys(stock, digests, secret);
  assert.equal(keys.get("one"), keys.get("two"));
  assert.match(keys.get("one"), /^v1:[a-f0-9]{64}$/);
  assert.doesNotMatch(keys.get("one"), /private|history/);
  assert.equal(JSON.stringify({ stock, digests }), before);
  assert.notEqual(publicSpecimenGroupKeys(stock, digests, "another-secret").get("one"), keys.get("one"));
  assert.notEqual(publicSpecimenGroupKeys(stock, { ...digests, two: "different-history" }, secret).get("two"), keys.get("one"));
});

test("arrival, price, status, notes, batch, site and tank differences keep fish separate", () => {
  for (const change of [
    { inDate: "2026-08-02" }, { basePrice: 99 }, { status: "healthy" },
    { notes: "another note" }, { batchId: "other-batch" },
    { siteId: "jiangyin" }, { subTankId: "other-tank" }, { productId: "other-product" },
  ]) {
    const keys = publicSpecimenGroupKeys([fish, { ...stock[1], ...change }], {}, secret);
    assert.notEqual(keys.get("one"), keys.get("two"), JSON.stringify(change));
  }
});

test("missing context or digest projection and ambiguous duplicate history fail closed", () => {
  for (const change of [{ inDate: "" }, { subTankId: "" }, { basePrice: "bad" }]) {
    assert.equal(publicSpecimenGroupKeys([{ ...fish, ...change }], {}, secret).get("one"), "");
  }
  assert.equal(publicSpecimenGroupKeys(stock, undefined, secret).get("one"), "");
  assert.equal(publicSpecimenGroupKeys(stock, { one: null }, secret).get("one"), "");
  assert.notEqual(publicSpecimenGroupKeys(stock, {}, secret).get("one"), "");
});

// Optional read-only Postgres check. It evaluates fixture JSON, never app_state.
test("Postgres compares full histories, ignores identity only, and rejects duplicate records", {
  skip: !process.env.FISHROOM_TEST_POSTGRES_CONTAINER,
}, () => {
  const base = { date: "2026-08-01T10:00:01", text: "Care", photos: ["/photo.jpg"], videos: ["/video.mp4"] };
  const changed = [
    { date: "2026-08-01T10:00:02" }, { text: "Care changed" }, { photos: ["/other.jpg"] },
    { videos: ["/other.mp4"] }, { operator: "someone" }, { sourceLogId: "another" },
    { tankLocation: "another" }, { nested: { private: "different" } },
  ];
  const records = ["one", "two", "with-older"].map((stockItemId) => ({ ...base, stockItemId, id: `record-${stockItemId}` }));
  records.push({ ...base, stockItemId: "with-older", id: "older", date: "2026-07-30", photos: [], videos: [], text: "Text-only treatment" });
  changed.forEach((change, index) => records.push({ ...base, ...change, stockItemId: `different-${index}`, id: `different-${index}` }));
  records.push({ ...base, stockItemId: "duplicate", id: "duplicate" }, { ...base, stockItemId: "duplicate", id: "duplicate" });
  const sql = `WITH source AS (SELECT '${JSON.stringify({ bioRecords: records }).replaceAll("'", "''")}'::jsonb AS data)
    SELECT ${PUBLIC_SPECIMEN_HISTORY_SQL} FROM source;`;
  const result = execFileSync("docker", ["exec", "-i", process.env.FISHROOM_TEST_POSTGRES_CONTAINER,
    "sh", "-c", 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'], { input: sql });
  const digests = JSON.parse(String(result));
  assert.equal(digests.one, digests.two);
  assert.notEqual(digests.one, digests["with-older"]);
  changed.forEach((_, index) => assert.notEqual(digests.one, digests[`different-${index}`]));
  assert.equal(digests.duplicate, null);
});
