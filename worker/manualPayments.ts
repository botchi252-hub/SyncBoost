import type { Env } from "./env";
import { ownerIds } from "./env";
import { escapeHtml } from "./i18n";
import { getSettings } from "./settings";
import { tg, webAppButton } from "./telegram";
import { usdText } from "./botMessages";

export type ManualPaymentMethod = "crypto" | "bank_transfer";
export type ManualPaymentStatus = "pending" | "approved" | "rejected";

export interface ManualPaymentRow {
  id: number;
  user_id: number;
  method: ManualPaymentMethod;
  amount: number;
  reference: string;
  status: ManualPaymentStatus;
  created_at: number;
  reviewed_at: number | null;
  reviewed_by: number | null;
}

function methodLabel(method: ManualPaymentMethod): string {
  return method === "crypto" ? "Crypto payment" : "Bank transfer";
}

/** Notify the already-configured owners/admins; this reuses the existing bot and never creates another bot. */
export async function notifyManualPaymentAdmins(env: Env, requestId: number): Promise<void> {
  const s = await getSettings(env);
  const row = await env.DB.prepare(
    `SELECT p.*, u.first_name, u.username FROM manual_payment_requests p
     LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?1`,
  ).bind(requestId).first<ManualPaymentRow & { first_name: string | null; username: string | null }>();
  if (!row) return;
  const admins = ownerIds(env, s);
  if (!admins.length) {
    console.error("manual payment request has no configured owner to notify", requestId);
    return;
  }
  const userName = `${row.first_name || "User"}${row.username ? ` (@${row.username})` : ""}`;
  const referenceLine = row.reference.trim()
    ? `Reference: <code>${escapeHtml(row.reference).slice(0, 240)}</code>`
    : row.method === "bank_transfer" ? "Reference: not required for bank transfers" : "Reference: not provided";
  const text =
    `💳 <b>Manual payment request #${row.id}</b>\n\n` +
    `Method: <b>${methodLabel(row.method)}</b>\n` +
    `Amount: <b>${usdText(row.amount)}</b>\n` +
    `Customer: ${escapeHtml(userName)} (<code>${row.user_id}</code>)\n` +
    `${referenceLine}\n\n` +
    `Review the transfer in the SyncBoost admin panel before approving it.`;
  const reply_markup = s.app_url
    ? { inline_keyboard: [[webAppButton("Review payment request", `${s.app_url}/#/admin/manual-payments`, "open")]] }
    : undefined;
  await Promise.all(admins.map((adminId) =>
    tg(env.BOT_TOKEN, "sendMessage", {
      chat_id: adminId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup,
    }).catch((e) => console.warn("manual payment admin notification failed", adminId, requestId, (e as Error).message)),
  ));
}

export async function notifyManualPaymentDecision(env: Env, request: ManualPaymentRow): Promise<void> {
  const s = await getSettings(env);
  const approved = request.status === "approved";
  const text = approved
    ? `✅ Your ${methodLabel(request.method).toLowerCase()} request #${request.id} was approved. ${usdText(request.amount)} has been added to your SyncBoost balance.`
    : `⚠️ Your ${methodLabel(request.method).toLowerCase()} request #${request.id} was not approved, so no balance was added. Please check the payment reference or contact support.`;
  const reply_markup = s.app_url
    ? { inline_keyboard: [[webAppButton("Open SyncBoost", `${s.app_url}/#/wallet`, "open")]] }
    : undefined;
  await tg(env.BOT_TOKEN, "sendMessage", {
    chat_id: request.user_id,
    text,
    link_preview_options: { is_disabled: true },
    reply_markup,
  }).catch((e) => console.warn("manual payment decision notification failed", request.id, (e as Error).message));
}
