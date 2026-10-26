import { describe, expect, it } from "vitest";
import { couponAmountMicroUsd, couponFailureCode, validCouponCode } from "../shared/coupons";

describe("coupon amount validation", () => {
  it("converts valid dollar amounts to integer micro-USD", () => {
    expect(couponAmountMicroUsd("0.01")).toBe(10_000);
    expect(couponAmountMicroUsd("1")).toBe(1_000_000);
    expect(couponAmountMicroUsd(12.5)).toBe(12_500_000);
    expect(couponAmountMicroUsd("1000.00")).toBe(1_000_000_000);
  });
  it("rejects empty, malformed, excessive precision, non-positive and over-limit values", () => {
    for (const value of ["", "abc", "1.2.3", "0", "0.001", "-1", "1000.01", "Infinity", "1.234"]) {
      expect(couponAmountMicroUsd(value)).toBeNull();
    }
    expect(couponAmountMicroUsd(null)).toBeNull();
  });
  it("normalizes coupon codes before route validation", () => {
    expect(validCouponCode(" sync-2026 ")).toBe(true);
    expect(validCouponCode("x")).toBe(false);
    expect(validCouponCode("invalid code")).toBe(false);
  });
});


describe("coupon redemption failure states", () => {
  const active = { enabled: 1, uses: 2, maxUses: 5, expiresAt: 2_000_000_000 };
  const now = 1_900_000_000;

  it("distinguishes a prior redemption from an invalid coupon", () => {
    expect(couponFailureCode({ alreadyRedeemed: true, coupon: active, now })).toBe("COUPON_ALREADY_USED");
    expect(couponFailureCode({ alreadyRedeemed: false, coupon: null, now })).toBe("COUPON_INVALID");
  });
  it("reports disabled, expired, and exhausted coupons accurately", () => {
    expect(couponFailureCode({ alreadyRedeemed: false, coupon: { ...active, enabled: 0 }, now })).toBe("COUPON_DISABLED");
    expect(couponFailureCode({ alreadyRedeemed: false, coupon: { ...active, expiresAt: now }, now })).toBe("COUPON_EXPIRED");
    expect(couponFailureCode({ alreadyRedeemed: false, coupon: { ...active, uses: 5 }, now })).toBe("COUPON_EXHAUSTED");
  });
  it("does not label a currently available coupon as expired or exhausted", () => {
    expect(couponFailureCode({ alreadyRedeemed: false, coupon: active, now })).toBe("COUPON_INVALID");
  });
});
