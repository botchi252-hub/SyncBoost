-- Money is stored as integer micro-dollars (1 USD = 1,000,000) to keep sub-cent prices exact.

CREATE TABLE users (
  id INTEGER PRIMARY KEY,               -- Telegram user id
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  username TEXT,
  photo_url TEXT,
  language_code TEXT,                   -- from Telegram
  lang TEXT,                            -- chosen app language (null = follow Telegram)
  balance INTEGER NOT NULL DEFAULT 0,
  notify INTEGER NOT NULL DEFAULT 0,    -- send order updates in chat
  can_message INTEGER NOT NULL DEFAULT 0, -- bot may write (started bot or granted write access)
  terms_accepted_at INTEGER,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

-- Mirror of NotPanel's `services` action. Only admin_* / enabled columns are ours.
CREATE TABLE services (
  id INTEGER PRIMARY KEY,               -- NotPanel service id
  platform TEXT NOT NULL,
  category TEXT NOT NULL,
  category_slug TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,                   -- English name from NotPanel
  type_key TEXT NOT NULL,
  rate INTEGER NOT NULL,                -- NotPanel cost per 1,000 (micro-USD)
  min INTEGER NOT NULL,
  max INTEGER NOT NULL,
  step INTEGER NOT NULL DEFAULT 1,
  refill INTEGER NOT NULL DEFAULT 0,
  cancel INTEGER NOT NULL DEFAULT 0,
  dripfeed INTEGER NOT NULL DEFAULT 0,
  drip_feed TEXT,                       -- JSON
  fields TEXT NOT NULL DEFAULT '[]',    -- JSON
  avg_minutes INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,      -- position in NotPanel's catalog (popular first)
  hash TEXT NOT NULL,                   -- fingerprint of the catalog entry, to store only changes
  present INTEGER NOT NULL DEFAULT 1,   -- still listed by NotPanel
  missed INTEGER NOT NULL DEFAULT 0,    -- full syncs in a row that didn't see it
  enabled INTEGER NOT NULL DEFAULT 1,   -- admin on/off
  custom_name TEXT,
  markup_pct REAL,                      -- per-service markup override
  fixed_rate INTEGER,                   -- per-service fixed price per 1,000 override
  description TEXT,
  first_seen_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX services_browse ON services (platform, category, sort);

CREATE TABLE service_names (
  service_id INTEGER NOT NULL,
  lang TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (service_id, lang)
) WITHOUT ROWID;

-- Pre-counted browse lists, rebuilt after each sync and admin change (keeps reads low on the free plan)
CREATE TABLE category_summary (
  platform TEXT NOT NULL,
  category TEXT NOT NULL,
  count INTEGER NOT NULL,
  from_rate REAL NOT NULL,              -- cheapest sell price per 1,000 (micro-USD, unrounded)
  sort INTEGER NOT NULL,
  PRIMARY KEY (platform, category)
) WITHOUT ROWID;

-- Admin overrides per category (and per platform with category = '')
CREATE TABLE category_rules (
  platform TEXT NOT NULL,
  category TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  markup_pct REAL,
  PRIMARY KEY (platform, category)
) WITHOUT ROWID;

CREATE TABLE price_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL,
  old_rate INTEGER NOT NULL,
  new_rate INTEGER NOT NULL,
  changed_at INTEGER NOT NULL
);
CREATE INDEX price_changes_at ON price_changes (changed_at DESC);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  service_id INTEGER NOT NULL,
  service_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  category TEXT NOT NULL,
  np_order_id INTEGER,
  link TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  fields TEXT,                          -- JSON of extra fields sent
  drip_minutes INTEGER,
  charge INTEGER NOT NULL,              -- what the user paid (micro-USD)
  cost INTEGER,                         -- what NotPanel charged us
  status TEXT NOT NULL,                 -- submitting|pending|processing|in_progress|completed|partial|cancelled|failed
  start_count INTEGER,
  remains INTEGER,
  reason_code TEXT,
  refund INTEGER NOT NULL DEFAULT 0,
  refunded INTEGER NOT NULL DEFAULT 0,
  can_cancel INTEGER NOT NULL DEFAULT 0,
  can_refill INTEGER NOT NULL DEFAULT 0,
  cancel_before INTEGER,
  refill_id INTEGER,
  refill_status TEXT,
  error TEXT,
  notified_status TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX orders_user ON orders (user_id, id DESC);
CREATE INDEX orders_open ON orders (status, checked_at);
CREATE UNIQUE INDEX orders_np ON orders (np_order_id) WHERE np_order_id IS NOT NULL;

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  stars INTEGER NOT NULL,
  amount INTEGER NOT NULL,              -- balance credited (micro-USD)
  draft TEXT,                           -- JSON order draft when paying for an order directly
  status TEXT NOT NULL,                 -- pending|paid|refunded
  charge_id TEXT UNIQUE,                -- telegram_payment_charge_id
  order_id INTEGER,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX payments_user ON payments (user_id, id DESC);
CREATE INDEX payments_status ON payments (status, id DESC);

-- Every balance movement
CREATE TABLE ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  delta INTEGER NOT NULL,
  kind TEXT NOT NULL,                   -- topup|order|refund|admin|stars_refund
  ref INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX ledger_user ON ledger (user_id, id DESC);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  received_at INTEGER NOT NULL
) WITHOUT ROWID;
