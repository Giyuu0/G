-- Run once with:
--   npx wrangler d1 execute atria-earning-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,              -- stable hash of source+external_id
  category TEXT NOT NULL,           -- code_bounty | translation | partner_offer | hackathon_grant | blog_content | digital_product
  source TEXT NOT NULL,             -- e.g. github, algora, devpost...
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  description TEXT,
  reward_text TEXT,                 -- raw reward string as found (e.g. "$150")
  reward_value REAL,                -- parsed numeric value if possible
  currency TEXT,
  discovered_at TEXT NOT NULL,
  age_hours REAL,                   -- age of the opportunity when discovered
  competition_signal INTEGER,       -- e.g. number of comments/PRs already on it
  score REAL,                       -- computed by scoring logic
  status TEXT NOT NULL DEFAULT 'discovered',
    -- discovered -> verified -> queued -> executing -> submitted -> needs_human -> paid -> rejected -> expired
  needs_human_reason TEXT,          -- filled when status = needs_human
  execution_output TEXT,            -- the actual work product (code diff, translation, proposal text...)
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_opportunities_status ON opportunities(status);
CREATE INDEX IF NOT EXISTS idx_opportunities_category ON opportunities(category);

CREATE TABLE IF NOT EXISTS agent_health (
  agent_name TEXT PRIMARY KEY,
  last_run_at TEXT,
  last_status TEXT,               -- ok | error
  last_error TEXT,
  run_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payments_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT NOT NULL,
  amount REAL,
  currency TEXT,
  paid_at TEXT,
  notes TEXT,
  FOREIGN KEY (opportunity_id) REFERENCES opportunities(id)
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ---------------------------------------------------------------------------
-- Token Treasury v2: tracks THREE separate Atria accounts (each with its own
-- 100M-token balance and its own per-minute rate limit). The treasury picks
-- which account to draw from for each approved allocation — this both
-- protects against wasting any single account's balance AND triples real
-- throughput since each account's rate limit is independent.
-- Set actual totals after deploy, e.g.:
--   UPDATE token_accounts SET total_tokens = 100000000 WHERE account_key = 'ATRIA_API_KEY_1';
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS token_accounts (
  account_key TEXT PRIMARY KEY,   -- name of the Worker secret holding this account's API key
  total_tokens REAL NOT NULL DEFAULT 0,
  used_tokens REAL NOT NULL DEFAULT 0,
  reserved_tokens REAL NOT NULL DEFAULT 0,
  last_used_at TEXT,
  low_balance_alert_sent INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO token_accounts (account_key) VALUES
  ('ATRIA_API_KEY_1'), ('ATRIA_API_KEY_2'), ('ATRIA_API_KEY_3');

CREATE TABLE IF NOT EXISTS token_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT,
  agent_name TEXT NOT NULL,
  account_key TEXT,
  decision TEXT NOT NULL,        -- approved | rejected | budget_frozen
  reason TEXT,
  allocated_max_tokens INTEGER,  -- what the treasury approved
  actual_prompt_tokens INTEGER,
  actual_completion_tokens INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
