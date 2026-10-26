import { describe, expect, it } from "vitest";
import { MINIMUM_DEPOSIT_MICRO_USD, validDepositAmountMicroUsd } from "../shared/deposits";

describe("manual deposit minimum", () => {
  it("accepts $1.00 and larger integer micro-USD amounts", () => {
    expect(MINIMUM_DEPOSIT_MICRO_USD).toBe(1_000_000);
    expect(validDepositAmountMicroUsd(1_000_000)).toBe(true);
    expect(validDepositAmountMicroUsd(2_500_000)).toBe(true);
  });
  it("rejects amounts below $1.00 and malformed values", () => {
    expect(validDepositAmountMicroUsd(999_999)).toBe(false);
    expect(validDepositAmountMicroUsd(0)).toBe(false);
    expect(validDepositAmountMicroUsd(-1)).toBe(false);
    expect(validDepositAmountMicroUsd(1.5)).toBe(false);
    expect(validDepositAmountMicroUsd("1000000")).toBe(false);
  });
});
