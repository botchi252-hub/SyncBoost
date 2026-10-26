import { describe, expect, it } from "vitest";
import { amount, balance, money } from "../src/format";

describe("USD-only monetary formatting", () => {
  it("formats service prices and amounts in dollars without a Stars equivalent", () => {
    expect(amount(1_000_000)).toBe("$1.00");
    expect(amount(12_500_000)).toBe("$12.50");
    expect(amount(1_000_000)).not.toContain("⭐");
  });

  it("keeps wallet balances in USD", () => {
    expect(balance(2_500_000)).toBe("$2.50");
  });

  it("preserves sign and useful precision for small USD values", () => {
    expect(money(-1_000_000)).toBe("−$1.00");
    expect(money(5_000)).toBe("$0.005");
  });
});
