// Minimal NotPanel API v3 client. https://notpanel.com/developers
// This project only works with NotPanel: the base URL is a constant (never a setting) and keys that don't look like
// NotPanel keys are refused before any request is made.
import { looksLikeNotPanelKey } from "../shared/brand";
import type { Env } from "./env";
import { getSettings, type Settings } from "./settings";

const BASE = "https://notpanel.com/api/v3";

export class NotPanelError extends Error {
  constructor(
    message: string,
    public code: string,
    public retryable: boolean,
    public status: number,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface NpService {
  service: string;
  name: string;
  type: string;
  category: string;
  rate: string;
  min: string | number;
  max: string | number;
  refill: boolean;
  cancel: boolean;
  dripfeed: boolean;
  type_key: string;
  platform: string | null;
  fields: unknown[];
  drip_feed: unknown;
  step: number;
  availability: string;
  average_time_minutes: number | null;
}

export interface NpStatus {
  order?: number;
  status: string;
  status_key: string;
  charge?: string;
  start_count?: string | number | null;
  remains?: string | number | null;
  refund?: string;
  reason_code?: string | null;
  can_cancel?: boolean;
  cancel_available?: boolean;
  can_refill?: boolean;
  cancel_before?: string;
  error?: string;
  error_code?: string;
}

export interface NpAddResult {
  order: number;
  status_key: string;
  charge: string;
  cancel_available?: boolean;
  cancel_before?: string;
  replayed?: boolean;
}

/** The key in use: the one saved in setup/admin, else the NOTPANEL_API_KEY secret. */
export const npKey = (env: Pick<Env, "NOTPANEL_API_KEY">, s: Pick<Settings, "np_api_key">): string => s.np_api_key.trim() || env.NOTPANEL_API_KEY?.trim() || "";

export async function np<T = unknown>(key: string, action: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  if (!looksLikeNotPanelKey(key)) throw new NotPanelError("Not a NotPanel API key", "INVALID_KEY", false, 0);
  key = key.trim();
  const body = new URLSearchParams({ key, action });
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") body.set(k, String(v));
  let res: Response;
  try {
    // Never follow a redirect: the key must only ever be sent to NotPanel ("manual" returns the 3xx unfollowed)
    res = await fetch(BASE, { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(25_000) });
  } catch (e) {
    throw new NotPanelError(`NotPanel unreachable: ${(e as Error).message}`, "NETWORK", true, 0);
  }
  const text = await res.text();
  let data: any;
  // An unparseable body is uncertain; preserve retry safety except when the HTTP status clearly signals an auth/provider issue.
  try {
    data = JSON.parse(text);
  } catch {
    // Even a non-JSON 401/403/429/5xx response must not hide an authentication or provider outage.
    const message = `Bad response from NotPanel (${res.status})`;
    const code = res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500
      ? inferErrorCode(message, res.status)
      : "BAD_RESPONSE";
    throw new NotPanelError(message, code, res.status === 429 || res.status >= 500, res.status);
  }
  if (data && typeof data === "object" && !Array.isArray(data) && typeof data.error === "string" && data.error.trim()) {
    // Older API-compatible responses sometimes omit error_code, or return an error object with HTTP 200.
    // Preserve their message and classify common account/provider failures instead of treating them as success.
    const rawCode = typeof data.error_code === "string" && data.error_code.trim() ? data.error_code.trim().toUpperCase() : "";
    const highSignalStatus = res.status === 401 || res.status === 403 || res.status === 429 || res.status >= 500;
    const specificCode = /^(?:INVALID_KEY|INVALID_API_KEY|INSUFFICIENT_BALANCE|ORDER_PLACEMENT_PAUSED|API_DISABLED|INACTIVE_ACCOUNT|ACCOUNT_SUSPENDED|EMAIL_UNVERIFIED|PROVIDER_UNAVAILABLE|PROVIDER_NOT_FOUND|PROVIDER_REJECTED|SERVICE_DISCONTINUED|SERVICE_NOT_FOUND|ORDER_NOT_FOUND|RATE_LIMITED|RATE_LIMIT_EXCEEDED|API_KEY_[A-Z_]+|KEY_[A-Z_]+|TOKEN_[A-Z_]+|AUTH(?:ENTICATION)?_[A-Z_]+|ACCOUNT_[A-Z_]+)$/.test(rawCode);
    // On auth/rate/server HTTP failures, do not let a generic error_code hide the real class of failure.
    // Preserve explicit account/key/provider/service codes because they guide the correct admin decision.
    const code = rawCode && (!highSignalStatus || specificCode) ? rawCode : inferErrorCode(data.error, res.status);
    const retryable = typeof data.retryable === "boolean" ? data.retryable : res.status === 429 || res.status >= 500;
    throw new NotPanelError(data.error, code, retryable, res.status, data.details);
  }
  if (!res.ok) {
    const message = `NotPanel error ${res.status}`;
    throw new NotPanelError(message, inferErrorCode(message, res.status), res.status === 429 || res.status >= 500, res.status);
  }
  return data as T;
}

function inferErrorCode(message: string, status: number): string {
  const m = message.toLowerCase();
  if (/invalid api key|api key (?:is )?(?:invalid|expired|revoked|disabled)|missing api key|invalid key|unauthori[sz]ed/.test(m) || status === 401) return "INVALID_KEY";
  if (/insufficient balance|not enough balance|account balance is below/.test(m)) return "INSUFFICIENT_BALANCE";
  if (/account (?:is )?(?:suspended|inactive|disabled)|suspended account|not permitted to perform/.test(m)) return "INACTIVE_ACCOUNT";
  if (/api (?:is )?disabled|order placement paused/.test(m)) return "API_DISABLED";
  if (/email (?:is )?unverified|verify your email/.test(m)) return "EMAIL_UNVERIFIED";
  if (/order not found/.test(m)) return "ORDER_NOT_FOUND";
  if (/service (?:has been )?discontinued/.test(m)) return "SERVICE_DISCONTINUED";
  if (/service not found/.test(m)) return "SERVICE_NOT_FOUND";
  if (/provider[_ ]not[_ ]found|no eligible provider|provider unavailable|no provider available|provider rejected/.test(m)) return "PROVIDER_UNAVAILABLE";
  if (/rate limit|too many requests/.test(m) || status === 429) return "RATE_LIMITED";
  if (status === 403) return "INACTIVE_ACCOUNT";
  if (status >= 500) return "UPSTREAM_UNAVAILABLE";
  return `HTTP_${status || 400}`;
}

/** Parses "0.40625" USD → micro-USD integer */
export function usdToMicro(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  return Math.round(Number(v) * 1_000_000);
}

/** np() with the effective key (settings are memoised, so this is cheap) */
export async function npCall<T = unknown>(env: Env, action: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
  return np<T>(npKey(env, await getSettings(env)), action, params);
}

export type KeyCheck = { ok: true } | { ok: false; code: "NOT_NOTPANEL_KEY" | "NOTPANEL_REJECTED"; message: string };

/**
 * Accepts a key only if it looks like a NotPanel key AND NotPanel itself answers the way NotPanel answers:
 * `balance` returns {balance, currency} and `catalog` (page 1, limit 1) returns a catalog page. Read-only calls.
 */
export async function verifyNotPanelKey(key: string): Promise<KeyCheck> {
  if (!looksLikeNotPanelKey(key)) return { ok: false, code: "NOT_NOTPANEL_KEY", message: "This is not a NotPanel API key (it starts with np_live_)." };
  const rejected = (e: unknown): KeyCheck => ({
    ok: false,
    code: "NOTPANEL_REJECTED",
    message: e instanceof NotPanelError && e.code !== "NETWORK" && e.code !== "BAD_RESPONSE" ? e.message : "NotPanel did not give the expected answer. Check the key and try again.",
  });
  try {
    const bal = await np<{ balance?: unknown; currency?: unknown }>(key, "balance");
    if (!bal || typeof bal !== "object" || !(typeof bal.balance === "string" || typeof bal.balance === "number") || typeof bal.currency !== "string")
      return { ok: false, code: "NOT_NOTPANEL_KEY", message: "This key did not answer like a NotPanel account." };
    const cat = await np<{ catalog_updated_at?: unknown; total_pages?: unknown; items?: { service?: unknown; platform?: { slug?: unknown } | null }[] }>(key, "catalog", { page: 1, limit: 1 });
    const first = Array.isArray(cat?.items) ? cat.items[0] : undefined;
    if (!cat || typeof cat.catalog_updated_at !== "string" || typeof cat.total_pages !== "number" || !first || first.service === undefined || (first.platform != null && typeof first.platform.slug !== "string"))
      return { ok: false, code: "NOT_NOTPANEL_KEY", message: "This key did not return the NotPanel catalog." };
    return { ok: true };
  } catch (e) {
    return rejected(e);
  }
}
