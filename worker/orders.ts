import { FINAL_STATUSES, type Lang, type OrderStatus, type OrderView, pickLang } from "../shared/types";
import type { Env } from "./env";
import { botText, escapeHtml } from "./i18n";
import { amountText, linkText, usdText } from "./botMessages";
import { NotPanelError, npCall, usdToMicro, type NpAddResult, type NpStatus } from "./notpanel";
import { orderCharge, quantityMode } from "./pricing";
import { getSettings } from "./settings";
import { ownerIds } from "./env";
import { tg, webAppButton } from "./telegram";
import type { ServiceDetail } from "../shared/types";

export interface OrderRow {
  id: number;
  user_id: number;
  service_id: number;
  service_name: string;
  platform: string;
  category: string;
  np_order_id: number | null;
  link: string;
  quantity: number;
  fields: string | null;
  drip_minutes: number | null;
  charge: number;
  cost: number | null;
  status: OrderStatus;
  start_count: number | null;
  remains: number | null;
  reason_code: string | null;
  refund: number;
  refunded: number;
  can_cancel: number;
  can_refill: number;
  cancel_before: number | null;
  refill_id: number | null;
  refill_status: string | null;
  error: string | null;
  notified_status: string | null;
  created_at: number;
  updated_at: number;
  checked_at: number;
}

export const OPEN_STATUSES: OrderStatus[] = ["submitting", "pending", "processing", "in_progress"];

export function orderView(o: OrderRow, paidWithStars = false): OrderView {
  const now = Math.floor(Date.now() / 1000);
  const inGrace = !!o.cancel_before && now < o.cancel_before;
  return {
    id: o.id,
    number: o.np_order_id ?? o.id,
    serviceId: o.service_id,
    serviceName: o.service_name,
    platform: o.platform,
    category: o.category,
    link: o.link,
    quantity: o.quantity,
    charge: o.charge,
    refund: o.refund,
    status: o.status,
    startCount: o.start_count,
    remains: o.remains,
    reasonCode: o.reason_code ?? (o.status === "failed" ? o.error : null),
    canCancel: OPEN_STATUSES.includes(o.status) && o.status !== "submitting" && (inGrace || !!o.can_cancel),
    canRefill: !!o.can_refill && (o.status === "completed" || o.status === "partial") && o.refill_status !== "pending",
    refillStatus: o.refill_status,
    paidWithStars,
    createdAt: o.created_at,
    updatedAt: o.updated_at,
  };
}

function normStatus(key: string | undefined): OrderStatus | null {
  switch (key) {
    case "pending":
    case "processing":
    case "in_progress":
    case "completed":
    case "partial":
      return key;
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return null;
  }
}

export class OrderError extends Error {
  constructor(public code: string, public details?: Record<string, unknown>) {
    super(code);
  }
}

type DeferTask = (promise: Promise<unknown>) => void;

/** NotPanel error codes that mean "your shop can't sell this right now" rather than "you typed something wrong". */
const SHOP_SIDE = new Set([
  "INSUFFICIENT_BALANCE", "ORDER_PLACEMENT_PAUSED", "API_DISABLED", "INVALID_KEY", "INVALID_API_KEY",
  "INACTIVE_ACCOUNT", "ACCOUNT_SUSPENDED", "EMAIL_UNVERIFIED", "PROVIDER_UNAVAILABLE", "PROVIDER_NOT_FOUND",
  "PROVIDER_REJECTED", "UPSTREAM_UNAVAILABLE", "RATE_LIMITED", "RATE_LIMIT_EXCEEDED", "HTTP_401", "HTTP_403",
  "HTTP_429", "HTTP_500", "HTTP_502", "HTTP_503", "HTTP_504", "FORBIDDEN", "UNAUTHORIZED",
  "AUTH_FAILED", "AUTHENTICATION_FAILED", "KEY_EXPIRED", "KEY_REVOKED", "KEY_DISABLED", "KEY_INVALID",
  "TOKEN_EXPIRED", "TOKEN_REVOKED", "TOKEN_INVALID",
]);

function isShopSideCode(code: string): boolean {
  if (SHOP_SIDE.has(code)) return true;
  // Generic upstream/server failures also need an admin decision; they may have happened after the provider accepted an order.
  if (/(?:UPSTREAM|SERVER|INTERNAL|GATEWAY|TIMEOUT|NETWORK)/.test(code)) return true;
  return /^(?:HTTP_(?:401|403|429|5\d\d)|API_KEY_[A-Z_]+|KEY_(?:INVALID|EXPIRED|REVOKED|DISABLED)|TOKEN_(?:INVALID|EXPIRED|REVOKED)|AUTH(?:ENTICATION)?_[A-Z_]+|ACCOUNT_[A-Z_]+|PROVIDER_[A-Z_]+)$/.test(code);
}

/** Keys the caller must never be able to set through user-supplied form fields. */
const RESERVED_PARAMS = new Set([
  "key", "action", "service", "link", "quantity", "request_id", "idempotency_key", "runs", "interval",
  "drip_feed_total_minutes", "orders", "order",
]);

/** Dev and production share one NotPanel account, so their idempotency keys must not collide. */
function requestId(env: Env, id: number): string {
  return `${env.DEV_FAKE_USER_ID ? "dev" : "o"}${id}`;
}

/**
 * Safety guard: a local dev setup (DEV_FAKE_USER_ID set) uses the live NotPanel key, so it must not place, cancel or
 * refill real orders unless ALLOW_LIVE_ORDERS=1 is set explicitly. (ALLOW_LIVE_ORDERS is declared on Env by worker/env.ts.)
 */
function assertOrdersAllowed(env: Env): void {
  const allow = (env as Env & { ALLOW_LIVE_ORDERS?: string }).ALLOW_LIVE_ORDERS;
  if (env.DEV_FAKE_USER_ID && allow !== "1") throw new OrderError("DEV_ORDERS_DISABLED");
}

/** Maps a NotPanel error for cancel/refill; shop-side codes are hidden behind SERVICE_UNAVAILABLE with no supplier details. */
function shopSafeError(e: NotPanelError): OrderError {
  if (isShopSideCode(e.code)) {
    console.error("NotPanel shop-side error", e.code, e.message);
    return new OrderError("SERVICE_UNAVAILABLE", undefined);
  }
  return new OrderError(e.code, e.details);
}

/**
 * Charges the user's balance and sends the order to NotPanel. If NotPanel rejects it, the charge is refunded.
 * If NotPanel can't be reached, the order stays "submitting" and the cron job recovers it by request_id.
 */
export async function placeOrder(
  env: Env,
  userId: number,
  svc: ServiceDetail & { cost: number },
  link: string,
  quantity: number,
  fields: Record<string, string>,
  dripMinutes: number | undefined,
  deferTask?: DeferTask,
): Promise<OrderRow> {
  assertOrdersAllowed(env);
  // svc.rate is the sell price per 1,000 in micro-USD; the charge is micro-USD (users see it as Stars)
  const charge = orderCharge(svc.rate, quantity, svc.quantityMode);
  const starsPerUsd = (await getSettings(env)).stars_per_usd;
  const now = Math.floor(Date.now() / 1000);
  const [debit, insert] = await env.DB.batch([
    env.DB.prepare("UPDATE users SET balance = balance - ?1 WHERE id = ?2 AND balance >= ?1 AND banned = 0").bind(charge, userId),
    env.DB.prepare(
      `INSERT INTO orders (user_id, service_id, service_name, platform, category, link, quantity, fields, drip_minutes, charge,
         rate, status, created_at, updated_at, checked_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?12, 'submitting', ?11, ?11, ?11 WHERE changes() = 1 RETURNING id`,
    ).bind(
      userId,
      svc.id,
      svc.name,
      svc.platform,
      svc.category,
      link,
      quantity,
      Object.keys(fields).length ? JSON.stringify(fields) : null,
      dripMinutes ?? null,
      charge,
      now,
      starsPerUsd,
    ),
    env.DB.prepare(
      "INSERT INTO ledger (user_id, delta, kind, ref, created_at) SELECT ?1, ?2, 'order', last_insert_rowid(), ?3 WHERE changes() = 1",
    ).bind(userId, -charge, now),
  ]);
  if (!debit.meta.changes) throw new OrderError("INSUFFICIENT_FUNDS", { charge });
  const id = (insert.results[0] as { id: number }).id;

  try {
    await submitExistingOrder(env, id);
  } catch (e) {
    if (e instanceof NotPanelError && isShopSideCode(e.code)) {
      // Provider balance/key/account/routing failures are held for an explicit admin decision, including retryable
      // provider-unavailable responses, instead of silently refunding before the owner can fix the connection.
      await markProviderReview(env, id, e.code, deferTask);
      return (await getOrderRow(env, id))!;
    }
    if (e instanceof NotPanelError && !e.retryable) {
      await failOrder(env, id, e.code);
      throw new OrderError(e.code, e.details);
    }
    console.warn("order submit pending recovery", id, (e as Error).message);
  }
  return (await getOrderRow(env, id))!;
}

/** Replays the same internal order using its stable request_id, so a timeout or admin retry cannot double-submit it. */
async function submitExistingOrder(env: Env, id: number): Promise<OrderRow> {
  const o = await getOrderRow(env, id);
  if (!o || o.status !== "submitting") throw new OrderError("ORDER_FINISHED");
  const storedFields = o.fields ? (JSON.parse(o.fields) as Record<string, string>) : {};
  const params: Record<string, string | number | undefined> = {};
  for (const [k, v] of Object.entries(storedFields)) if (!RESERVED_PARAMS.has(k) && typeof v === "string") params[k] = v;
  const type = await env.DB.prepare("SELECT type_key FROM services WHERE id = ?1").bind(o.service_id).first<{ type_key: string }>();
  Object.assign(params, {
    service: o.service_id,
    link: o.link,
    request_id: requestId(env, id),
    quantity: type && quantityMode(type.type_key) === "free" ? o.quantity : undefined,
    drip_feed_total_minutes: o.drip_minutes ?? undefined,
  });
  const r = await npCall<NpAddResult>(env, "add", params);
  const addStatus = normStatus(r.status_key) ?? "pending";
  const addCost = usdToMicro(r.charge);
  if (addCost > o.charge) console.warn("order sold below cost", { order: id, charge: o.charge, cost: addCost });
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    `UPDATE orders SET np_order_id = ?1, status = ?2, cost = ?3, can_cancel = ?4, cancel_before = ?5,
       error = NULL, reason_code = NULL, updated_at = ?6, checked_at = ?6 WHERE id = ?7 AND status = 'submitting'`,
  ).bind(
    r.order,
    addStatus,
    addCost,
    r.cancel_available ? 1 : 0,
    r.cancel_before ? Math.floor(Date.parse(r.cancel_before) / 1000) : null,
    now,
    id,
  ).run();
  // A replayed order can already be finished: run it through the normal path so refunds and notifications happen.
  if (FINAL_STATUSES.includes(addStatus)) {
    const row = await getOrderRow(env, id);
    if (row) await applyStatus(env, row, { ...(r as object), status: r.status_key, status_key: r.status_key } as NpStatus);
  }
  return (await getOrderRow(env, id))!;
}

function providerReviewCode(error: string | null): string | null {
  if (!error?.startsWith("PROVIDER_REVIEW:")) return null;
  return error.slice("PROVIDER_REVIEW:".length) || "SERVICE_UNAVAILABLE";
}

async function markProviderReview(env: Env, id: number, code: string, deferTask?: DeferTask): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const changed = await env.DB.prepare(
    `UPDATE orders SET status = 'submitting', error = ?2, reason_code = ?3, updated_at = ?4, checked_at = ?4
     WHERE id = ?1 AND status = 'submitting' AND refunded = 0`,
  ).bind(id, `PROVIDER_REVIEW:${code}`, code, now).run();
  const row = await getOrderRow(env, id);
  if (changed.meta.changes && row) {
    const notification = notifyProviderIssue(env, row, code).catch((e) => console.warn("provider issue notification failed", id, (e as Error).message));
    if (deferTask) deferTask(notification);
    else await notification;
  }
}

async function notifyProviderIssue(env: Env, o: OrderRow, code: string): Promise<void> {
  const s = await getSettings(env);
  const admins = ownerIds(env, s);
  if (!admins.length) {
    console.error("provider issue has no configured owner to notify", o.id, code);
    return;
  }
  const user = await env.DB.prepare("SELECT username, first_name FROM users WHERE id = ?1")
    .bind(o.user_id).first<{ username: string | null; first_name: string | null }>();
  const who = `${user?.first_name || "User"}${user?.username ? ` (@${user.username})` : ""}`;
  const text =
    `⚠️ <b>SyncBoost provider/API issue</b>

` +
    `Order: <b>#${o.id}</b> · ${escapeHtml(o.service_name)}
` +
    `Customer: ${escapeHtml(who)} (<code>${o.user_id}</code>)
` +
    `Provider response: <code>${escapeHtml(code)}</code>
` +
    `Amount held: <b>${usdText(o.charge)}</b>

` +
    `<i>The order is paused and the customer has not been refunded. Choose Fixed to retry with the same request ID, or Not fixed to stop and refund. For an ambiguous server error, the bot checks whether the provider already accepted the order before refunding.</i>`;
  const keyboard = { inline_keyboard: [[
    { text: "✅ Fixed — retry order", callback_data: `provider:fixed:${o.id}` },
    { text: "❌ Not fixed — refund", callback_data: `provider:unfixed:${o.id}` },
  ]] };
  await Promise.all(admins.map((adminId) => tg(env.BOT_TOKEN, "sendMessage", {
    chat_id: adminId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard,
  }).catch((e) => console.warn("provider issue notification failed", adminId, o.id, (e as Error).message))));
}

export type ProviderReviewResult = "stale" | "retried" | "pending" | "still_unavailable" | "failed_refunded";

/** Admin action: claim a pending provider issue and replay it using the original idempotency key. */
export async function retryProviderIssue(env: Env, id: number): Promise<ProviderReviewResult> {
  assertOrdersAllowed(env);
  const now = Math.floor(Date.now() / 1000);
  const claim = await env.DB.prepare(
    `UPDATE orders SET error = 'PROVIDER_RETRYING', updated_at = ?2, checked_at = ?2
     WHERE id = ?1 AND status = 'submitting' AND error LIKE 'PROVIDER_REVIEW:%' AND refunded = 0`,
  ).bind(id, now).run();
  if (!claim.meta.changes) return "stale";
  try {
    const updated = await submitExistingOrder(env, id);
    return updated.error?.startsWith("PROVIDER_REVIEW:") ? "still_unavailable" : updated.np_order_id ? "retried" : "pending";
  } catch (e) {
    if (e instanceof NotPanelError && isShopSideCode(e.code)) {
      await markProviderReview(env, id, e.code);
      return "still_unavailable";
    }
    if (e instanceof NotPanelError && !e.retryable) {
      await failOrder(env, id, e.code);
      const failed = await getOrderRow(env, id);
      if (failed) await notifyOrder(env, failed);
      return "failed_refunded";
    }
    // A timeout may mean NotPanel accepted the request. Leave it submitting with the stable request_id and let the
    // normal order_details recovery path resolve it; never create a replacement order.
    await env.DB.prepare("UPDATE orders SET error = NULL, updated_at = ?2, checked_at = ?2 WHERE id = ?1 AND status = 'submitting' AND error = 'PROVIDER_RETRYING'")
      .bind(id, now).run();
    console.warn("admin provider retry is awaiting idempotent recovery", id, (e as Error).message);
    return "pending";
  }
}

/** Errors where an add may have reached the provider despite a server-side failure. */
function ambiguousProviderOutcome(code: string): boolean {
  return code === "UPSTREAM_UNAVAILABLE" || /^HTTP_5\d\d$/.test(code) || /(?:UPSTREAM|SERVER|INTERNAL|GATEWAY|TIMEOUT|NETWORK)/.test(code);
}

export type ProviderRejectResult = "stale" | "refunded" | "order_found" | "could_not_verify";

/** Admin action: safely close a held order and credit the refund exactly once. */
export async function rejectProviderIssue(env: Env, id: number): Promise<ProviderRejectResult> {
  const current = await getOrderRow(env, id);
  const code = providerReviewCode(current?.error ?? null);
  if (!current || current.status !== "submitting" || !code || current.refunded) return "stale";

  // A generic 5xx can arrive after the provider accepted an add. Check the original request_id before refunding.
  // Definite authentication, account-balance, and explicit provider-not-found errors skip this extra request.
  if (ambiguousProviderOutcome(code)) {
    let found: (NpStatus & { order: number }) | null = null;
    try {
      found = await npCall<NpStatus & { order: number }>(env, "order_details", { request_id: requestId(env, id) });
    } catch (e) {
      if (!(e instanceof NotPanelError && e.code === "ORDER_NOT_FOUND")) {
        console.warn("could not verify provider order before refund", id, (e as Error).message);
        await notifyProviderIssue(env, current, code);
        return "could_not_verify";
      }
      // A confirmed ORDER_NOT_FOUND means the provider did not create this logical order.
    }
    if (found) {
      const providerStatus = normStatus(found.status_key) ?? "pending";
      const now = Math.floor(Date.now() / 1000);
      const linked = await env.DB.prepare(
        `UPDATE orders SET np_order_id = ?2, status = ?3, cost = ?4, can_cancel = ?5, cancel_before = ?6,
         error = NULL, reason_code = NULL, updated_at = ?7, checked_at = ?7
         WHERE id = ?1 AND status = 'submitting' AND error LIKE 'PROVIDER_REVIEW:%' AND refunded = 0`,
      ).bind(
        id,
        found.order,
        providerStatus,
        usdToMicro(found.charge),
        found.cancel_available ? 1 : 0,
        found.cancel_before ? Math.floor(Date.parse(found.cancel_before) / 1000) : null,
        now,
      ).run();
      if (!linked.meta.changes) return "stale";
      const linkedRow = await getOrderRow(env, id);
      if (linkedRow) {
        const settled = await applyStatus(env, linkedRow, found);
        if (!FINAL_STATUSES.includes(settled.status)) {
          const s = await getSettings(env);
          const user = await env.DB.prepare("SELECT can_message, lang, language_code FROM users WHERE id = ?1")
            .bind(settled.user_id).first<{ can_message: number; lang: string | null; language_code: string | null }>();
          if (user?.can_message) {
            const lang = pickLang(user.lang ?? user.language_code);
            await tg(env.BOT_TOKEN, "sendMessage", {
              chat_id: settled.user_id,
              text: `✅ We recovered order #${settled.np_order_id ?? settled.id} with the provider. It is continuing to process, so no refund was made.`,
              reply_markup: s.app_url ? { inline_keyboard: [[webAppButton(botText(lang, "viewOrder"), `${s.app_url}/#/order/${settled.id}`, "viewOrder")]] } : undefined,
            }).catch((e) => console.warn("provider recovery user notification failed", settled.id, (e as Error).message));
          }
        }
      }
      return "order_found";
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE orders SET status = 'failed', error = 'SERVICE_UNAVAILABLE', reason_code = 'SERVICE_UNAVAILABLE',
       refund = charge, refunded = 1, notified_status = 'failed', updated_at = ?2, checked_at = ?2
       WHERE id = ?1 AND status = 'submitting' AND error LIKE 'PROVIDER_REVIEW:%' AND refunded = 0`,
    ).bind(id, now),
    env.DB.prepare(
      `INSERT INTO ledger (user_id, delta, kind, ref, note, created_at)
       SELECT user_id, refund, 'refund', id, 'provider unavailable', ?2 FROM orders
       WHERE id = ?1 AND status = 'failed' AND error = 'SERVICE_UNAVAILABLE' AND notified_status = 'failed' AND changes() = 1 AND refund > 0`,
    ).bind(id, now),
    env.DB.prepare(
      `UPDATE users SET balance = balance + (SELECT refund FROM orders WHERE id = ?1)
       WHERE id = (SELECT user_id FROM orders WHERE id = ?1) AND changes() = 1`,
    ).bind(id),
  ]);
  if (!results[0]?.meta.changes) return "stale";
  const o = await getOrderRow(env, id);
  if (!o) return "refunded";
  const s = await getSettings(env);
  const user = await env.DB.prepare("SELECT can_message, lang, language_code FROM users WHERE id = ?1")
    .bind(o.user_id).first<{ can_message: number; lang: string | null; language_code: string | null }>();
  if (user?.can_message) {
    const lang = pickLang(user.lang ?? user.language_code);
    const text =
      `⚠️ <b>Provider unavailable</b>\n\n` +
      `We could not process order <b>#${o.id}</b> because the service provider is temporarily unavailable. ` +
      `<b>${usdText(o.refund)}</b> has been refunded to your SyncBoost balance. Please try again later.`;
    try {
      await tg(env.BOT_TOKEN, "sendMessage", {
        chat_id: o.user_id,
        text,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: s.app_url ? { inline_keyboard: [[webAppButton(botText(lang, "open"), `${s.app_url}/#/wallet`, "open")]] } : undefined,
      });
    } catch (e) {
      console.warn("provider refund user notification failed", o.id, (e as Error).message);
    }
  }
  return "refunded";
}

export async function getOrderRow(env: Env, id: number): Promise<OrderRow | null> {
  return env.DB.prepare("SELECT * FROM orders WHERE id = ?1").bind(id).first<OrderRow>();
}

/** Marks an order as failed and refunds the full charge (once). */
async function failOrder(env: Env, id: number, code: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE orders SET status = 'failed', error = ?2, refund = charge, refunded = 1, updated_at = ?3 WHERE id = ?1 AND refunded = 0",
    ).bind(id, code, now),
    ...creditRefundStmts(env, id, now),
  ]);
}

/** Credits orders.refund to the user — only runs if the immediately preceding UPDATE changed the row. */
function creditRefundStmts(env: Env, id: number, now: number): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `INSERT INTO ledger (user_id, delta, kind, ref, created_at)
       SELECT user_id, refund, 'refund', id, ?2 FROM orders WHERE id = ?1 AND changes() = 1 AND refund > 0`,
    ).bind(id, now),
    env.DB.prepare(
      `UPDATE users SET balance = balance + (SELECT refund FROM orders WHERE id = ?1)
       WHERE id = (SELECT user_id FROM orders WHERE id = ?1) AND changes() = 1`,
    ).bind(id),
  ];
}

export function refundFor(o: OrderRow, status: OrderStatus, remains: number | null, st?: NpStatus): number {
  if (status === "partial" && remains === null) {
    // No remains from NotPanel: split our charge in the same ratio as NotPanel's own refund vs. charge
    if (st && st.refund !== undefined && st.refund !== "" && st.charge !== undefined && st.charge !== "") {
      const npRefund = usdToMicro(st.refund);
      const npCharge = usdToMicro(st.charge);
      if (npRefund >= 0 && npCharge >= 0 && npCharge + npRefund > 0) {
        return Math.max(0, Math.min(o.charge, Math.ceil((o.charge * npRefund) / (npCharge + npRefund) - 1e-9)));
      }
    }
    console.error("partial order without remains or refund info; refunding 0", o.id);
    return 0;
  }
  if (status === "partial" || status === "cancelled") {
    if (status === "partial" || (remains !== null && remains > 0 && remains < o.quantity)) {
      const left = Math.max(0, Math.min(remains ?? 0, o.quantity));
      // Rounded up in the user's favour, never more than they paid
      return Math.min(o.charge, Math.ceil((o.charge * left) / o.quantity - 1e-9));
    }
    return o.charge;
  }
  return 0;
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

/** Applies a NotPanel status (from polling or a webhook). Refunds and notifies when the order finishes. */
export async function applyStatus(env: Env, o: OrderRow, st: NpStatus): Promise<OrderRow> {
  const status = normStatus(st.status_key);
  if (!status) return o;
  // Out-of-order event (e.g. a late "processing" after "completed"): the order is already final, ignore it
  if (FINAL_STATUSES.includes(o.status) && !FINAL_STATUSES.includes(status)) return o;
  const now = Math.floor(Date.now() / 1000);
  const remains = num(st.remains);
  await env.DB.prepare(
    `UPDATE orders SET status = ?2, start_count = ?3, remains = ?4, reason_code = ?5, can_cancel = ?6, can_refill = ?7,
       cost = COALESCE(?8, cost), updated_at = CASE WHEN status = ?2 AND remains IS ?4 THEN updated_at ELSE ?9 END, checked_at = ?9
     WHERE id = ?1`,
  )
    .bind(
      o.id,
      status,
      num(st.start_count),
      remains,
      st.reason_code ?? null,
      st.cancel_available ?? st.can_cancel ? 1 : 0,
      st.can_refill ? 1 : 0,
      st.charge !== undefined ? usdToMicro(st.charge) : null,
      now,
    )
    .run();

  if (FINAL_STATUSES.includes(status) && !o.refunded) {
    const refund = refundFor(o, status, remains, st);
    await env.DB.batch([
      env.DB.prepare("UPDATE orders SET refund = ?2, refunded = 1 WHERE id = ?1 AND refunded = 0").bind(o.id, refund),
      ...creditRefundStmts(env, o.id, now),
    ]);
  }
  const updated = (await getOrderRow(env, o.id))!;
  if (FINAL_STATUSES.includes(status) && updated.notified_status !== status) await notifyOrder(env, updated);
  return updated;
}

/** Sends "order completed" etc. to the user's chat if they turned on updates. */
export async function notifyOrder(env: Env, o: OrderRow): Promise<void> {
  const claimed = await env.DB.prepare("UPDATE orders SET notified_status = ?2 WHERE id = ?1 AND notified_status IS NOT ?2")
    .bind(o.id, o.status)
    .run();
  if (!claimed.meta.changes) return;
  const user = await env.DB.prepare("SELECT notify, can_message, lang, language_code FROM users WHERE id = ?1")
    .bind(o.user_id)
    .first<{ notify: number; can_message: number; lang: string | null; language_code: string | null }>();
  if (!user?.notify || !user.can_message) return;
  const s = await getSettings(env);
  if (!s.app_url) return;
  const lang: Lang = pickLang(user.lang ?? user.language_code);
  const key = ({ completed: "orderCompleted", partial: "orderPartial", cancelled: "orderCancelled", failed: "orderFailed" } as const)[
    o.status as "completed" | "partial" | "cancelled" | "failed"
  ];
  if (!key) return;
  const text = botText(lang, key, {
    id: String(o.np_order_id ?? o.id),
    service: o.service_name,
    quantity: o.quantity.toLocaleString("en-US"),
    refund: amountText(o.refund, s),
    link: linkText(o.link),
  });
  try {
    await tg(env.BOT_TOKEN, "sendMessage", {
      chat_id: o.user_id,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[webAppButton(botText(lang, "viewOrder"), `${s.app_url}/#/order/${o.id}`, "viewOrder")]] },
    });
  } catch (e) {
    // 403 = the user blocked the bot; stop trying
    if (String((e as Error).message).includes("403")) await env.DB.prepare("UPDATE users SET can_message = 0 WHERE id = ?1").bind(o.user_id).run();
    else console.warn("notify failed", (e as Error).message);
  }
}

/** Fetches the live status of one order (used when the user opens it). */
export async function refreshOrder(env: Env, o: OrderRow): Promise<OrderRow> {
  if (!OPEN_STATUSES.includes(o.status) && !(o.refill_id && o.refill_status === "pending")) return o;
  try {
    if (o.np_order_id && o.status !== "submitting") {
      const st = await npCall<NpStatus>(env, "status", { order: o.np_order_id });
      o = await applyStatus(env, o, st);
    } else if (o.status === "submitting") {
      o = await recoverSubmitting(env, o);
    }
    if (o.refill_id && o.refill_status === "pending") {
      const r = await npCall<{ status_key: string }>(env, "refill_status", { refill: o.refill_id });
      const rs = r.status_key === "completed" || r.status_key === "rejected" ? r.status_key : "pending";
      if (rs !== "pending") await env.DB.prepare("UPDATE orders SET refill_status = ?2 WHERE id = ?1").bind(o.id, rs).run();
      o = (await getOrderRow(env, o.id))!;
    }
  } catch (e) {
    console.warn("refresh failed", o.id, (e as Error).message);
  }
  return o;
}

/** An order whose add call timed out: ask NotPanel by request_id whether it exists. */
async function recoverSubmitting(env: Env, o: OrderRow): Promise<OrderRow> {
  // Do not race an admin retry: only the retry handler may touch this row until it releases the claim.
  if (providerReviewCode(o.error) || o.error === "PROVIDER_RETRYING") return o;
  try {
    const d = await npCall<NpStatus & { order: number }>(env, "order_details", { request_id: requestId(env, o.id) });
    await env.DB.prepare("UPDATE orders SET np_order_id = ?2 WHERE id = ?1").bind(o.id, d.order).run();
    return applyStatus(env, { ...o, np_order_id: d.order }, d);
  } catch (e) {
    const now = Math.floor(Date.now() / 1000);
    if (e instanceof NotPanelError && isShopSideCode(e.code)) {
      await markProviderReview(env, o.id, e.code);
      return (await getOrderRow(env, o.id)) ?? o;
    }
    if (e instanceof NotPanelError && e.code === "ORDER_NOT_FOUND" && now - o.created_at > 600) {
      await failOrder(env, o.id, "SUBMIT_FAILED");
      const failed = (await getOrderRow(env, o.id))!;
      await notifyOrder(env, failed);
      return failed;
    }
    await env.DB.prepare("UPDATE orders SET checked_at = ?2 WHERE id = ?1").bind(o.id, now).run();
    return o;
  }
}

/**
 * Cron backup for webhooks (runs every minute): re-checks open orders that haven't been checked for 20 minutes.
 * Stays well under the free plan's ~50 D1 queries per run: at most 12 open orders and 3 submitting recoveries,
 * and it stops early when a rough query budget is used up (unprocessed orders keep their old checked_at and go first next time).
 */
export async function pollOpenOrders(env: Env): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const BUDGET = 40;
  let used = 2; // the two selects below
  const [open, stuck] = await env.DB.batch<OrderRow>([
    env.DB.prepare(
      `SELECT * FROM orders WHERE status IN ('pending','processing','in_progress') AND np_order_id IS NOT NULL AND checked_at < ?1
       ORDER BY checked_at LIMIT 12`,
    ).bind(now - 1200),
    env.DB.prepare(`SELECT * FROM orders WHERE status = 'submitting' AND checked_at < ?1 AND COALESCE(error, '') NOT LIKE 'PROVIDER_REVIEW:%' AND COALESCE(error, '') != 'PROVIDER_RETRYING' ORDER BY checked_at LIMIT 3`).bind(now - 240),
  ]);
  const withId = open.results;
  if (withId.length) {
    try {
      const map = await npCall<Record<string, NpStatus>>(env, "status", { orders: withId.map((o) => o.np_order_id).join(",") });
      for (const o of withId) {
        const st = map[String(o.np_order_id)];
        const next = st && !st.error_code ? normStatus(st.status_key) : null;
        const cost = next && FINAL_STATUSES.includes(next) ? 7 : 2;
        if (used + cost > BUDGET) break;
        used += cost;
        if (st && !st.error_code) await applyStatus(env, o, st);
        else await env.DB.prepare("UPDATE orders SET checked_at = ?2 WHERE id = ?1").bind(o.id, now).run();
      }
    } catch (e) {
      console.warn("poll failed", (e as Error).message);
    }
  }
  for (const o of stuck.results) {
    if (used + 8 > BUDGET) break;
    used += 8;
    await recoverSubmitting(env, o);
  }
}

export async function cancelOrder(env: Env, o: OrderRow): Promise<OrderRow> {
  assertOrdersAllowed(env);
  if (!o.np_order_id) throw new OrderError("CANCEL_NOT_AVAILABLE");
  try {
    await npCall(env, "cancel", { order: o.np_order_id });
  } catch (e) {
    if (e instanceof NotPanelError) throw shopSafeError(e);
    throw e;
  }
  const st = await npCall<NpStatus>(env, "status", { order: o.np_order_id });
  return applyStatus(env, o, st);
}

export async function refillOrder(env: Env, o: OrderRow): Promise<OrderRow> {
  assertOrdersAllowed(env);
  if (!o.np_order_id) throw new OrderError("REFILL_NOT_AVAILABLE");
  try {
    const r = await npCall<{ refill: number }>(env, "refill", { order: o.np_order_id });
    await env.DB.prepare("UPDATE orders SET refill_id = ?2, refill_status = 'pending' WHERE id = ?1").bind(o.id, r.refill).run();
  } catch (e) {
    if (e instanceof NotPanelError) throw shopSafeError(e);
    throw e;
  }
  return (await getOrderRow(env, o.id))!;
}
