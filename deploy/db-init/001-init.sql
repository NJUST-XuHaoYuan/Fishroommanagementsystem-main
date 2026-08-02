CREATE TABLE IF NOT EXISTS app_state (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
