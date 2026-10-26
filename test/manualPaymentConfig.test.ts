import { describe, expect, it } from "vitest";
import { manualPaymentInstructions } from "../shared/manualPaymentConfig";

describe("manual payment configuration", () => {
  it("formats complete crypto settings with explicit asset, network, and address labels", () => {
    expect(manualPaymentInstructions("crypto", {
      crypto_asset: "USDT",
      crypto_network: "TRON (TRC20)",
      crypto_address: "T-test-wallet",
      crypto_instructions: "Send exact amount",
    })).toBe("Asset: USDT\nNetwork: TRON (TRC20)\nDeposit address: T-test-wallet\nSend exact amount");
  });

  it("does not mark incomplete or instructions-only structured crypto settings as available", () => {
    expect(manualPaymentInstructions("crypto", { crypto_instructions: "Send exact amount" })).toBe("");
    expect(manualPaymentInstructions("crypto", { crypto_asset: "USDT", crypto_network: "TRON" })).toBe("");
  });

  it("keeps the legacy crypto instructions as a compatibility fallback", () => {
    expect(manualPaymentInstructions("crypto", {
      crypto_asset: "USDT",
      crypto_network: "TRON",
      crypto_payment_details: "Legacy configured instructions",
    })).toBe("Legacy configured instructions");
  });

  it("formats complete bank details and optional instructions with real newlines", () => {
    expect(manualPaymentInstructions("bank_transfer", {
      bank_name: "Example Bank",
      bank_account_name: "SyncBoost",
      bank_account_number: "1234567890",
      bank_instructions: "Use your Telegram username as narration",
    })).toBe("Bank name: Example Bank\nAccount name: SyncBoost\nAccount number: 1234567890\nUse your Telegram username as narration");
  });

  it("does not mark incomplete bank settings as available, but retains legacy fallback", () => {
    expect(manualPaymentInstructions("bank_transfer", { bank_name: "Example Bank" })).toBe("");
    expect(manualPaymentInstructions("bank_transfer", { bank_transfer_details: "Legacy bank instructions" })).toBe("Legacy bank instructions");
  });
});
