BEGIN;

SELECT pg_advisory_xact_lock(hashtext('fishroom'), hashtext('app_state_revision_v1'));

CREATE SEQUENCE IF NOT EXISTS app_state_revision_seq;

CREATE TABLE IF NOT EXISTS app_state (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  revision BIGINT NOT NULL DEFAULT nextval('app_state_revision_seq'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE app_state
  ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT nextval('app_state_revision_seq');

LOCK TABLE app_state IN ACCESS EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS app_state_revision_trigger ON app_state;

CREATE OR REPLACE FUNCTION bump_app_state_revision()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR NEW.revision IS NULL OR NEW.revision <= 0 THEN
    NEW.revision := nextval('app_state_revision_seq');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

SELECT setval(
  'app_state_revision_seq',
  GREATEST(
    (SELECT COALESCE(MAX(revision), 0) FROM app_state),
    (SELECT last_value FROM app_state_revision_seq),
    1
  ),
  true
);

UPDATE app_state
SET revision = nextval('app_state_revision_seq');

SELECT setval(
  'app_state_revision_seq',
  GREATEST(
    (SELECT COALESCE(MAX(revision), 0) FROM app_state),
    (SELECT last_value FROM app_state_revision_seq),
    1
  ),
  true
);

CREATE TRIGGER app_state_revision_trigger
BEFORE INSERT OR UPDATE ON app_state
FOR EACH ROW EXECUTE FUNCTION bump_app_state_revision();

COMMIT;

CREATE TABLE IF NOT EXISTS finance_import_batches (
  id TEXT PRIMARY KEY,
  state_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_by TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  matched_count INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  totals JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (state_id, site_id, platform, file_hash)
);

CREATE TABLE IF NOT EXISTS finance_platform_settlements (
  id TEXT PRIMARY KEY,
  state_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  platform TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  external_order_no TEXT NOT NULL,
  sub_order_no TEXT NOT NULL DEFAULT '',
  settlement_time TEXT NOT NULL DEFAULT '',
  order_time TEXT NOT NULL DEFAULT '',
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (state_id, site_id, platform, fingerprint)
);

CREATE INDEX IF NOT EXISTS finance_platform_settlements_order_idx
  ON finance_platform_settlements (state_id, site_id, platform, external_order_no);

CREATE TABLE IF NOT EXISTS finance_account_transfers (
  id TEXT PRIMARY KEY,
  state_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  source_account TEXT NOT NULL,
  target_account TEXT NOT NULL,
  expected_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  actual_amount NUMERIC(14, 2) NOT NULL DEFAULT 0,
  transferred_at TEXT NOT NULL,
  transaction_no TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  import_batch_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  proof JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  verified_by TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS finance_account_transfers_site_idx
  ON finance_account_transfers (state_id, site_id, transferred_at DESC);
