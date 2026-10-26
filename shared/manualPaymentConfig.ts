export type ManualPaymentMethod = "crypto" | "bank_transfer";

/** Minimal settings shape needed to resolve public manual-payment instructions. */
export interface ManualPaymentSettings {
  crypto_asset?: unknown;
  crypto_network?: unknown;
  crypto_address?: unknown;
  crypto_instructions?: unknown;
  crypto_payment_details?: unknown;
  bank_name?: unknown;
  bank_account_name?: unknown;
  bank_account_number?: unknown;
  bank_instructions?: unknown;
  bank_transfer_details?: unknown;
}

const value = (v: unknown): string => String(v ?? "").trim();

/**
 * Prefer the complete structured configuration. If it is not complete, fall back only to
 * the legacy all-in-one instructions (for existing deployments); never publish partial
 * structured payment details or declare an instructions-only method available.
 */
export function manualPaymentInstructions(method: ManualPaymentMethod, settings: ManualPaymentSettings): string {
  if (method === "crypto") {
    const asset = value(settings.crypto_asset);
    const network = value(settings.crypto_network);
    const address = value(settings.crypto_address);
    const additional = value(settings.crypto_instructions);
    if (asset && network && address) {
      return [
        `Asset: ${asset}`,
        `Network: ${network}`,
        `Deposit address: ${address}`,
        additional,
      ].filter(Boolean).join("\n");
    }
    return value(settings.crypto_payment_details);
  }

  const bank = value(settings.bank_name);
  const accountName = value(settings.bank_account_name);
  const accountNumber = value(settings.bank_account_number);
  const additional = value(settings.bank_instructions);
  if (bank && accountName && accountNumber) {
    return [
      `Bank name: ${bank}`,
      `Account name: ${accountName}`,
      `Account number: ${accountNumber}`,
      additional,
    ].filter(Boolean).join("\n");
  }
  return value(settings.bank_transfer_details);
}
