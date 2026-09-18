import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { migrateLegacyStockPricingState, stockPricingProtectedIds } from "./stock-pricing.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const withoutPricing = ({ basePrice, priceMode, priceOverridden, ...rest }) => rest;

/** Explicit deployment migration. Dry-run is read-only; apply locks the live row. */
export async function runStockPricingMigration(pool, { apply = false, stateId = "main" } = {}) {
  const client = await pool.connect();
  try {
    await client.query(apply ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SET LOCAL lock_timeout = '10s'");
    const result = await client.query(`SELECT data, revision FROM app_state WHERE id = $1${apply ? " FOR UPDATE" : ""}`, [stateId]);
    assert.equal(result.rows.length, 1, "Expected one live state row");
    const before = result.rows[0].data;
    assert.ok(Array.isArray(before.stock), "Stock must be an array");
    const beforeHash = hash(before);
    const migration = migrateLegacyStockPricingState(before);
    const after = migration.state;
    const { stock: oldStock, ...otherBefore } = before;
    const { stock: newStock, ...otherAfter } = after;
    assert.equal(hash(before), beforeHash, "Migration mutated its source");
    assert.equal(hash(otherBefore), hash(otherAfter), "Non-stock business data changed");
    assert.equal(oldStock.length, newStock.length, "Stock count changed");
    const protectedIds = stockPricingProtectedIds(before);
    oldStock.forEach((item, index) => {
      const next = newStock[index];
      assert.deepEqual(withoutPricing(next), withoutPricing(item), "Non-pricing stock fields changed");
      if (protectedIds.has(String(item.id).trim())) assert.deepEqual(next.basePrice, item.basePrice, "Protected historical price changed");
      if (item.priceMode === "manual" || (!item.priceMode && item.priceOverridden === true)) assert.deepEqual(next, item, "Manual stock changed");
    });
    assert.equal(migrateLegacyStockPricingState(after).changed, false, "Migration is not idempotent");
    const report = {
      applied: apply && migration.changed, beforeRevision: String(result.rows[0].revision),
      counts: migration.counts, exceptions: migration.exceptions,
      beforeHash, afterHash: hash(after), businessDataHash: hash(otherBefore),
      businessDataUnchanged: true, protectedPricesUnchanged: true, manualPricesUnchanged: true,
    };
    if (apply && migration.changed) {
      await client.query(`CREATE TABLE IF NOT EXISTS stock_pricing_migration_audit (
        id BIGSERIAL PRIMARY KEY, state_id TEXT NOT NULL, migrated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        release_revision TEXT NOT NULL, before_revision BIGINT NOT NULL, after_revision BIGINT NOT NULL,
        report JSONB NOT NULL
      )`);
      const updated = await client.query("UPDATE app_state SET data = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING revision", [stateId, JSON.stringify(after)]);
      assert.equal(updated.rows.length, 1, "State update failed");
      report.afterRevision = String(updated.rows[0].revision);
      assert.ok(BigInt(report.afterRevision) > BigInt(report.beforeRevision), "State revision must advance to invalidate stale clients");
      await client.query("INSERT INTO stock_pricing_migration_audit (state_id, release_revision, before_revision, after_revision, report) VALUES ($1, $2, $3, $4, $5::jsonb)",
        [stateId, process.env.RELEASE_REVISION || "unversioned", report.beforeRevision, report.afterRevision, JSON.stringify(report)]);
      await client.query("COMMIT");
    } else await client.query("ROLLBACK");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {});
  try { console.log(JSON.stringify(await runStockPricingMigration(pool, { apply: process.argv.includes("--apply") }), null, 2)); }
  catch (error) { console.error(`Stock pricing migration failed: ${error.code || error.message}`); process.exitCode = 1; }
  finally { await pool.end(); }
}
