/** Manual deposits are accepted in USD micro-units, with a $1.00 minimum. */
export const MINIMUM_DEPOSIT_MICRO_USD = 1_000_000;
export function validDepositAmountMicroUsd(amount: unknown): amount is number {
  return typeof amount === "number" && Number.isSafeInteger(amount) && amount >= MINIMUM_DEPOSIT_MICRO_USD;
}
