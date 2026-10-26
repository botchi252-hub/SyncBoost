# SyncBoost update report — re-examined review copy

## Status

This is a review-ready source package, not a production deployment. The second inspection found and corrected additional defects in the earlier update package. The checks that do not require installed project dependencies passed. A full Vite build, Vitest run, and TypeScript typecheck could not be completed in this environment; see Verification below.

## Changes made

- **USD-only customer display:** the shared amount formatter now returns USD only. Wallet ledger icons and labels no longer imply every top-up used Stars. Order checkout uses the USD wallet; Star Payment is available through Deposit only. The legacy payment-recovery route remains for old in-flight payments, but its screen uses generic payment wording.
- **Deposit choices:** users first choose Star Payment, Crypto Transfer, or Bank Transfer. Each choice opens its own details and form. The $1.00 minimum is validated in the UI and on the manual-deposit API; Star Payment also requires enough Stars to credit at least $1.00 while respecting configured Stars limits.
- **Separate admin configuration:** crypto asset, network, address, and optional instructions are separate from bank name, account name, account number, and optional instructions. Existing combined settings are retained as an explicit fallback for compatibility and can be cleared in the admin panel. Structured configuration is validated as a complete set, and public instructions use the same resolver as the submit endpoint.
- **Manual transfer workflow:** bank submissions do not require a reference field. Crypto submissions require a transaction hash/reference. Blank bank references no longer collide in the database index. Requests remain pending until admin review; the configured support usernames are shown in the 10-minute delay guidance. Admin lists and notifications explicitly say when a bank reference is not required rather than showing an empty reference field. Approval remains guarded by a pending-only transition, and the ledger/balance credit occurs once.
- **Coupon validation and messages:** the amount is parsed as USD with at most two decimal places and stored as integer micro-USD. The existing $1,000 maximum is retained; empty, malformed, non-positive, excessive-precision, and over-limit amounts are rejected. The admin field removes extra decimal points, duplicate-create submissions are guarded, and errors now distinguish invalid, disabled, expired, exhausted, already-used, and duplicate coupons. The existing atomic redemption flow and unique per-user redemption key were preserved.
- **Settings/legal wording:** the default terms wording now mentions verified crediting and admin review for manual transfers. The admin Stars settings help text now reflects the Deposit-only Star Payment flow.
- **Localization:** added USD/deposit/error strings across the English source and 19 locale dictionaries. The supplied dictionaries were missing 46 English keys each before this re-review; these now have explicit English fallback strings, matching the application's existing fallback behavior and bringing each dictionary to the same 329-key set.
- **Tests added:** coupon validation/failure states, deposit minimum, structured/legacy manual-payment instructions, and USD-only formatting.

## Coupon bug investigation

The code review found inconsistent amount validation and generic failure reporting: the amount input could hold malformed decimal strings (for example, multiple decimal points), while the API grouped invalid code, amount, limit, and expiry into the same `INVALID_VALUE` result. This made amount failures hard to diagnose. The API now parses a strict USD-cent amount and returns clearer failure states. I did not find a separate duplicate-credit defect in the existing redemption SQL: it already uses a `(code, user_id)` primary key and conditional usage, ledger, and balance updates. That idempotency path was exercised against SQLite locally; production Cloudflare D1 integration was not available here.

## Main files changed

- `src/format.ts`, `src/screens/TopUp.tsx`, `src/screens/Wallet.tsx`, `src/screens/OrderForm.tsx`, `src/screens/OrderDetail.tsx`, `src/screens/OrderPlaced.tsx` — USD display, deposit choices, and payment-flow separation.
- `src/admin/AdminRoutes.tsx`, `worker/manualPayments.ts`, `worker/settings.ts`, `worker/routes/admin.ts` — separate payment settings, validation, compatibility fallbacks, Stars minimum checks, coupon creation behavior, and updated default terms.
- `worker/routes/app.ts` — manual-payment configuration resolution, minimum-deposit enforcement, method-specific reference requirements, checkout separation, and coupon failure responses.
- `shared/coupons.ts`, `shared/deposits.ts`, `shared/manualPaymentConfig.ts` — reusable validation/configuration helpers.
- `src/i18n/en.ts`, `src/i18n/*.json` — consistent USD/deposit/error copy and complete key coverage.
- `migrations/0010_payment_configuration.sql` — new structured payment settings and partial unique index for non-empty references.
- `test/coupon.test.ts`, `test/deposit.test.ts`, `test/manualPaymentConfig.test.ts`, `test/format.test.ts` — focused regression tests.

## Verification

Passed:

- TypeScript/TSX syntax transpilation: all 84 source/test files, zero syntax diagnostics.
- All 10 SQL migrations applied in order to a fresh local SQLite database.
- Local SQLite checks: blank bank references may repeat; duplicate non-empty references are blocked within a payment method; repeat admin approval credits the balance/ledger exactly once; repeat coupon redemption does not increment coupon usage or credit the balance twice.
- Direct assertions against the new coupon, deposit, and manual-payment helper functions.
- Localization checks: all 19 JSON locale files contain the same 329 keys as English, with non-empty values, matching placeholders, and no stray braces; existing i18n content checks passed.

Not verified in this environment:

- `npm test` could not start because `vitest` is not installed.
- `npm run build` could not start because `vite` is not installed.
- `npm run typecheck` stops because `@cloudflare/workers-types` and `vite/client` are unavailable.
- The project declares Node.js >=24, while the available runtime is Node.js 22.16.0. Dependency installation failed because the registry was unreachable/offline, so those toolchain checks need to be rerun in an environment with Node.js 24+ and dependencies installed.

## Safety and delivery notes

- `migrations/0010_payment_configuration.sql` is included for review only. No production migration, deploy, or Git push was performed.
- The source ZIP supplied for this task included a local `.dev.vars.txt` file with credential variables. That file is intentionally excluded from the review ZIP. A sanitized `.dev.vars.example` template has been added to match the README's local-development instructions. If an earlier ZIP containing `.dev.vars.txt` was shared outside this private conversation, rotate those credentials.
- The specification referred to three project/reference files, but only the project ZIP and the specification document were present. The supplied project ZIP was treated as the working copy; no unavailable reference file was guessed or copied over it.
