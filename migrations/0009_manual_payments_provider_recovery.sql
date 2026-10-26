-- Manual payment requests (crypto and bank transfer) are reviewed by an existing admin.
-- Provider/API errors remain queued for an admin's explicit retry-or-refund decision.
CREATE TABLE IF NOT EXISTS manual_payment_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('crypto', 'bank_transfer')),
  amount INTEGER NOT NULL CHECK (amount > 0), -- USD micro-units credited to the wallet on approval
  reference TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  reviewed_by INTEGER
);
CREATE INDEX IF NOT EXISTS manual_payment_requests_status ON manual_payment_requests (status, created_at DESC);
CREATE INDEX IF NOT EXISTS manual_payment_requests_user ON manual_payment_requests (user_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS manual_payment_reference_unique ON manual_payment_requests (method, lower(trim(reference)));
