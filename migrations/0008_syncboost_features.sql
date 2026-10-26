-- SyncBoost onboarding, community gates, and coupon credits.
ALTER TABLE users ADD COLUMN captcha_verified_at INTEGER;
ALTER TABLE users ADD COLUMN community_verify_at INTEGER;

CREATE TABLE IF NOT EXISTS captcha_challenges (
  user_id INTEGER PRIMARY KEY,
  operand_a INTEGER NOT NULL,
  operand_b INTEGER NOT NULL,
  answer INTEGER NOT NULL,
  choices TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  last_attempt_at INTEGER
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY,
  amount INTEGER NOT NULL CHECK (amount > 0), -- USD micro-units
  max_uses INTEGER NOT NULL CHECK (max_uses > 0),
  uses INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  code TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (code, user_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_user ON coupon_redemptions(user_id, redeemed_at DESC);

-- Keep one short-lived, single-use invite per user and community instead of creating unlimited links on every tap.
CREATE TABLE IF NOT EXISTS community_invites (
  user_id INTEGER NOT NULL,
  community_id TEXT NOT NULL,
  invite_link TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, community_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_community_invites_expiry ON community_invites(expires_at);

INSERT OR IGNORE INTO settings (key, value) VALUES ('required_chats', '[]');
INSERT OR IGNORE INTO settings (key, value) VALUES ('support_username_2', '');
INSERT OR IGNORE INTO settings (key, value) VALUES ('referral_reward_usd', '2000000');

-- Upgrade the original untouched default (30%) to SyncBoost's requested 40%; preserve custom admin values.
UPDATE settings SET value = '40' WHERE key = 'default_markup_pct' AND value = '30';

-- Apply the requested SyncBoost identity to this deployment. Admins can customize it again after migration.
UPDATE settings SET value = 'SyncBoost' WHERE key = 'brand_name';
UPDATE settings SET value = '0' WHERE key = 'logo_ver';

-- Earlier versions could let users through with an unconfirmed membership status; require a fresh check now.
UPDATE users SET channel_ok = 0, channel_checked_at = NULL WHERE channel_ok = 2;
