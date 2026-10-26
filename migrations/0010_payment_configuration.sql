-- Split manual payment configuration into structured, method-specific settings.
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('crypto_asset', ''),
  ('crypto_network', ''),
  ('crypto_address', ''),
  ('crypto_instructions', ''),
  ('bank_name', ''),
  ('bank_account_name', ''),
  ('bank_account_number', ''),
  ('bank_instructions', '');

-- Bank transfers do not inherently require a transaction reference; retain uniqueness only for provided references.
DROP INDEX IF EXISTS manual_payment_reference_unique;
CREATE UNIQUE INDEX IF NOT EXISTS manual_payment_reference_unique
  ON manual_payment_requests (method, lower(trim(reference)))
  WHERE trim(reference) <> '';
