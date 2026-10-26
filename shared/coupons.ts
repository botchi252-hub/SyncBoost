/** Parse a coupon credit expressed in USD into integer micro-USD. Coupons are cent-denominated. */
export function couponAmountMicroUsd(value: unknown): number | null {
  const raw = typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : typeof value === "string" ? value.trim() : "";
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) return null;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0.01 || usd > 1000) return null;
  const micro = Math.round(usd * 1_000_000);
  return Number.isSafeInteger(micro) && micro > 0 ? micro : null;
}

export function validCouponCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9_-]{3,32}$/.test(value.trim().toUpperCase());
}

export interface CouponAvailabilityState {
  enabled: number | boolean;
  uses: number;
  maxUses: number;
  expiresAt: number | null;
}

/** Return the specific failure code for an unsuccessful redemption attempt. */
export function couponFailureCode(input: {
  alreadyRedeemed: boolean;
  coupon: CouponAvailabilityState | null | undefined;
  now: number;
}): "COUPON_ALREADY_USED" | "COUPON_INVALID" | "COUPON_DISABLED" | "COUPON_EXPIRED" | "COUPON_EXHAUSTED" {
  if (input.alreadyRedeemed) return "COUPON_ALREADY_USED";
  const coupon = input.coupon;
  if (!coupon) return "COUPON_INVALID";
  if (!coupon.enabled) return "COUPON_DISABLED";
  if (coupon.expiresAt !== null && coupon.expiresAt <= input.now) return "COUPON_EXPIRED";
  if (coupon.uses >= coupon.maxUses) return "COUPON_EXHAUSTED";
  return "COUPON_INVALID";
}
