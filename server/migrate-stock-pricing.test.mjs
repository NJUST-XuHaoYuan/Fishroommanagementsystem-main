import assert from "node:assert/strict";
import test from "node:test";
import { runStockPricingMigration } from "./migrate-stock-pricing.mjs";

const state = () => ({ products: [{ id: "p", defaultPrice: 150 }], stock: [
  { id: "old", productId: "p", basePrice: 100, priceMode: "legacy", notes: "keep" },
  { id: "manual", productId: "p", basePrice: 110, priceMode: "manual" },
  { id: "sold", productId: "p", basePrice: 120, sold: true },
], orders: [{ id: "o", items: [{ stockItemId: "sold", price: 130 }], payments: [{ amount: 130 }] }], refunds: [{ amount: 10 }], batches: [{ cost: 75 }] });

function database(initial, { failAudit = false } = {}) {
  let persisted = structuredClone(initial), pending, revision = 17;
  const calls = [], audits = [];
  const client = {
    async query(sql, values = []) {
      calls.push(sql);
      if (sql.startsWith("BEGIN")) pending = structuredClone(persisted);
      if (sql.startsWith("SELECT data")) return { rows: [{ data: structuredClone(persisted), revision }] };
      if (sql.startsWith("UPDATE app_state")) { pending = JSON.parse(values[1]); return { rows: [{ revision: revision + 1 }] }; }
      if (sql.startsWith("INSERT INTO stock_pricing_migration_audit")) {
        if (failAudit) throw new Error("AUDIT_FAILURE");
        audits.push(JSON.parse(values[4]));
      }
      if (sql === "COMMIT") { persisted = pending; revision += 1; }
      if (sql === "ROLLBACK") pending = undefined;
      return { rows: [] };
    }, release() { calls.push("release"); },
  };
  return { connect: async () => client, calls, audits, get state() { return persisted; } };
}

test("deployment preview reads a consistent snapshot without locks or SQL writes", async () => {
  const initial = state(), pool = database(initial);
  const report = await runStockPricingMigration(pool);
  assert.equal(report.applied, false);
  assert.equal(report.counts.candidates, 2);
  assert.equal(report.counts.priceUpdated, 1);
  assert.deepEqual(pool.state, initial);
  assert.ok(pool.calls[0].includes("READ ONLY"));
  assert.ok(!pool.calls.some(sql => /FOR UPDATE|^UPDATE|^CREATE|^INSERT/.test(sql)));
});

test("deployment apply locks the latest row, preserves financial records, audits and is idempotent", async () => {
  const initial = state(), pool = database(initial);
  const report = await runStockPricingMigration(pool, { apply: true });
  assert.equal(report.applied, true);
  assert.equal(report.afterRevision, "18");
  assert.ok(pool.calls.some(sql => sql.includes("FOR UPDATE")));
  assert.equal(pool.state.stock[0].basePrice, 150);
  assert.equal(pool.state.stock[2].basePrice, 120);
  assert.deepEqual(pool.state.stock[1], initial.stock[1]);
  for (const key of ["orders", "refunds", "batches", "products"]) assert.deepEqual(pool.state[key], initial[key]);
  assert.equal(pool.audits.length, 1);
  const repeated = await runStockPricingMigration(pool, { apply: true });
  assert.equal(repeated.applied, false);
  assert.equal(repeated.counts.candidates, 0);
  assert.equal(pool.audits.length, 1);
});

test("audit failure rolls back the stock update rather than leaving an untracked migration", async () => {
  const initial = state(), pool = database(initial, { failAudit: true });
  await assert.rejects(runStockPricingMigration(pool, { apply: true }), /AUDIT_FAILURE/);
  assert.deepEqual(pool.state, initial);
  assert.equal(pool.calls.at(-2), "ROLLBACK");
  assert.equal(pool.calls.at(-1), "release");
});
