import { Hono, type Context } from "hono";
import { type LedgerItem, type Me, type OrderDraft, pickLang, type Lang, LANGS } from "../../shared/types";
import { validateInitData, type TgUser } from "../auth";
import { getService, listCategories, listPlatforms, listServices, searchServices } from "../catalog";
import { type Env, isOwner } from "../env";
import { MAX_STARS_PER_PAYMENT } from "../../shared/stars";
import { MINIMUM_DEPOSIT_MICRO_USD, validDepositAmountMicroUsd } from "../../shared/deposits";
import { manualPaymentInstructions } from "../../shared/manualPaymentConfig";
import { couponFailureCode } from "../../shared/coupons";
import { starsText } from "../botMessages";
import { cancelOrder, getOrderRow, OrderError, orderView, placeOrder, refillOrder, refreshOrder, type OrderRow } from "../orders";
import { createInvoice, TooManyInvoices } from "../payments";
import { notifyManualPaymentAdmins } from "../manualPayments";
import { attachReferral, channelGateRequired, communityStatuses, onHomeReached, parseRef, referralStats, requiredCommunities, RetryLater, rewardMicro, verifyChannel } from "../growth";
import { checkDraft, orderCharge } from "../pricing";
import { brandInfo, brandName } from "../brand";
import { getSettings, type Settings } from "../settings";
import { tg } from "../telegram";

export interface UserRow {
  id: number;
  first_name: string;
  last_name: string;
  username: string | null;
  photo_url: string | null;
  language_code: string | null;
  lang: string | null;
  balance: number;
  notify: number;
  can_message: number;
  terms_accepted_at: number | null;
  banned: number;
  channel_ok: number;
  channel_checked_at: number | null;
  home_at: number | null;
  captcha_verified_at: number | null;
}

type Vars = { tgUser: TgUser; user: UserRow; settings: Settings; lang: Lang; startParam: string | null };
export type AppEnv = { Bindings: Env; Variables: Vars };
type C = Context<AppEnv>;

export const err = (c: C, status: number, code: string, details?: Record<string, unknown>) =>
  c.json({ error: code, code, details }, status as 400);

/** Parses a JSON request body; null unless it is a plain object (not an array, null or a primitive). */
export async function readBody<T extends object>(c: Context): Promise<T | null> {
  const b: unknown = await c.req.json().catch(() => null);
  return b !== null && typeof b === "object" && !Array.isArray(b) ? (b as T) : null;
}

/** Non-negative page number from a query value: NaN/Infinity/huge values fall back to 0 or the 0..1000 clamp. */
export function pageParam(v: string | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.min(1000, Math.max(0, Math.trunc(n))) : 0;
}

/** Cursor query value (`before=`): a finite positive number, else "no cursor". */
const cursorParam = (v: string | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 2 ** 53) : 2 ** 53;
};

/**
 * Creates the user (order updates on by default) or refreshes their Telegram profile. To keep D1 writes low with many
 * users, an existing row is only rewritten when the profile changed or last_seen_at is over a day old.
 */
async function upsertUser(env: Env, u: TgUser): Promise<UserRow> {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare(
    `INSERT INTO users (id, first_name, last_name, username, photo_url, language_code, notify, created_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?7)
     ON CONFLICT(id) DO UPDATE SET first_name = excluded.first_name, last_name = excluded.last_name, username = excluded.username,
       photo_url = excluded.photo_url, language_code = excluded.language_code, last_seen_at = excluded.last_seen_at
     WHERE users.first_name IS NOT excluded.first_name OR users.last_name IS NOT excluded.last_name
       OR users.username IS NOT excluded.username OR users.photo_url IS NOT excluded.photo_url
       OR users.language_code IS NOT excluded.language_code OR users.last_seen_at < excluded.last_seen_at - 86400
     RETURNING *`,
  )
    .bind(u.id, u.first_name ?? "", u.last_name ?? "", u.username ?? null, u.photo_url ?? null, u.language_code ?? null, now)
    .first<UserRow>();
  return row ?? (await env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(u.id).first<UserRow>())!;
}

export const app = new Hono<AppEnv>();

// Auth: every /api request carries Telegram's signed initData.
const LOCAL_HOSTS = ["localhost", "127.0.0.1"];
let warnedDevBypass = false;

app.use("*", async (c, next) => {
  const auth = c.req.header("authorization") ?? "";
  let tgUser: TgUser | null = null;
  let startParam: string | null = null;
  if (auth.startsWith("tma ")) {
    const data = await validateInitData(auth.slice(4), c.env.BOT_TOKEN);
    tgUser = data?.user ?? null;
    startParam = data?.startParam ?? null;
  } else if (c.env.DEV_FAKE_USER_ID && !LOCAL_HOSTS.includes(new URL(c.req.url).hostname)) {
    // Never honour the dev bypass on a real host, even if the variable is set by mistake
    if (!warnedDevBypass) {
      warnedDevBypass = true;
      console.error("DEV_FAKE_USER_ID is set but the request host is not local; ignoring it. Remove it from this environment.");
    }
  } else if (c.env.DEV_FAKE_USER_ID) {
    const cookieUser = /(?:^|;\s*)dev_user=(\d+)/.exec(c.req.header("cookie") ?? "")?.[1];
    const devId = Number(c.req.header("x-dev-user") || cookieUser || c.env.DEV_FAKE_USER_ID);
    tgUser = { id: devId, first_name: devId === Number(c.env.DEV_FAKE_USER_ID) ? "Dev" : `Tester${devId}`, last_name: "User", username: "dev", language_code: "en" };
    startParam = c.req.header("x-dev-start") ?? null;
  }
  if (!tgUser) return err(c, 401, "UNAUTHORIZED");
  const isMe = c.req.path.endsWith("/api/me") && c.req.method === "GET";
  let user = isMe ? null : await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(tgUser.id).first<UserRow>();
  if (!user) user = await upsertUser(c.env, tgUser);
  if (user.banned) return err(c, 403, "BANNED");
  const settings = await getSettings(c.env);
  c.set("tgUser", tgUser);
  c.set("user", user);
  c.set("settings", settings);
  c.set("lang", pickLang(user.lang ?? user.language_code));
  c.set("startParam", startParam);
  await next();
});

// App data and actions are locked server-side too; only the endpoints needed to finish onboarding remain open.
app.use("*", async (c, next) => {
  const path = c.req.path.replace(/^\/api(?=\/|$)/, "") || "/";
  const onboarding = path === "/me" || path === "/terms" || path === "/captcha" || path === "/captcha/verify" ||
    path === "/communities/status" || /^\/communities\/\d+\/invite$/.test(path) || path === "/channel/verify";
  if (onboarding) return next();
  const user = c.get("user");
  if (!user.captcha_verified_at) return err(c, 403, "CAPTCHA_REQUIRED");
  if (!user.terms_accepted_at) return err(c, 403, "TERMS_REQUIRED");
  if (await channelGateRequired(c.env, c.get("settings"), user)) return err(c, 403, "CHANNEL_REQUIRED");
  await next();
});

async function meView(c: C, background?: (p: Promise<unknown>) => void): Promise<Me> {
  const u = c.get("user");
  const s = c.get("settings");
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.service_id, o.service_name, o.platform, o.link, o.quantity FROM orders o
     WHERE o.id IN (SELECT MAX(id) FROM (SELECT id, service_id, link FROM orders WHERE user_id = ?1 AND status != 'failed' ORDER BY id DESC LIMIT 30) GROUP BY service_id, link)
     ORDER BY o.id DESC LIMIT 3`,
  )
    .bind(u.id)
    .all<{ id: number; service_id: number; service_name: string; platform: string; link: string; quantity: number }>();
  return {
    id: u.id,
    firstName: u.first_name,
    lastName: u.last_name,
    username: u.username,
    photoUrl: u.photo_url,
    lang: c.get("lang"),
    langChosen: u.lang !== null,
    balance: u.balance,
    notify: !!u.notify,
    canMessage: !!u.can_message,
    termsAccepted: !!u.terms_accepted_at,
    isAdmin: isOwner(c.env, s, u.id),
    starsPerUsd: s.stars_per_usd,
    minTopup: s.min_topup_stars,
    maxTopup: Math.min(s.max_topup_stars, MAX_STARS_PER_PAYMENT),
    supportUsername: s.support_username || null,
    supportUsername2: s.support_username_2 || null,
    channelUrl: s.channel_url || null,
    requiredCommunities: requiredCommunities(s).map(({ id, title }) => ({ id, title })),
    captchaVerified: !!u.captcha_verified_at,
    channelRequired: await channelGateRequired(c.env, s, u, { background }),
    referralEnabled: !!s.referral_enabled,
    referralReward: rewardMicro(s),
    botUsername: s.bot_username || null,
    brand: brandInfo(s),
    recent: results.map((r) => ({ id: r.id, serviceId: r.service_id, serviceName: r.service_name, platform: r.platform, link: r.link, quantity: r.quantity })),
  };
}

app.get("/me", async (c) => {
  // Mini App opened from a referral link (t.me/<bot>/app?startapp=ref_<id>): link the new user to the referrer
  const ref = parseRef(c.get("startParam"));
  if (ref) await attachReferral(c.env, c.get("settings"), c.get("user").id, ref);
  return c.json(await meView(c, (p) => c.executionCtx.waitUntil(p)));
});

// One-time, server-validated arithmetic challenge after language selection.
function randomInt(min: number, max: number): number {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return min + (n[0] % (max - min + 1));
}
function makeMathChallenge() {
  const a = randomInt(2, 20), b = randomInt(2, 20), answer = a + b;
  const choices = new Set<number>([answer]);
  while (choices.size < 3) choices.add(Math.max(1, answer + randomInt(-9, 9)));
  const arr = [...choices];
  for (let i = arr.length - 1; i > 0; i--) { const j = randomInt(0, i); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return { a, b, answer, choices: arr };
}
async function currentChallenge(env: Env, userId: number) {
  const now = Math.floor(Date.now() / 1000);
  const user = await env.DB.prepare("SELECT captcha_verified_at FROM users WHERE id = ?1").bind(userId).first<{ captcha_verified_at: number | null }>();
  if (user?.captcha_verified_at) return { verified: true as const };
  let row = await env.DB.prepare("SELECT operand_a, operand_b, answer, choices, attempts, updated_at FROM captcha_challenges WHERE user_id = ?1")
    .bind(userId).first<{ operand_a: number; operand_b: number; answer: number; choices: string; attempts: number; updated_at: number }>();
  if (row && row.attempts >= 5 && now - row.updated_at < 3600) return { verified: false as const, locked: true as const, attemptsLeft: 0, retryAt: row.updated_at + 3600 };
  if (!row || row.attempts >= 5) {
    const q = makeMathChallenge();
    await env.DB.prepare(`INSERT INTO captcha_challenges (user_id, operand_a, operand_b, answer, choices, attempts, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6) ON CONFLICT(user_id) DO UPDATE SET operand_a=excluded.operand_a, operand_b=excluded.operand_b,
      answer=excluded.answer, choices=excluded.choices, attempts=0, updated_at=excluded.updated_at`)
      .bind(userId, q.a, q.b, q.answer, JSON.stringify(q.choices), now).run();
    row = { operand_a: q.a, operand_b: q.b, answer: q.answer, choices: JSON.stringify(q.choices), attempts: 0, updated_at: now };
  }
  return { verified: false as const, locked: false as const, a: row.operand_a, b: row.operand_b, choices: JSON.parse(row.choices) as number[], attemptsLeft: Math.max(0, 5 - row.attempts) };
}
app.get("/captcha", async (c) => {
  if (!c.get("user").lang) return err(c, 400, "LANGUAGE_REQUIRED");
  return c.json(await currentChallenge(c.env, c.get("user").id));
});
app.post("/captcha/verify", async (c) => {
  if (!c.get("user").lang) return err(c, 400, "LANGUAGE_REQUIRED");
  const body = await readBody<{ answer?: unknown }>(c);
  const answer = Number(body?.answer);
  if (!Number.isSafeInteger(answer)) return err(c, 400, "INVALID_ANSWER");
  const userId = c.get("user").id;
  const now = Math.floor(Date.now() / 1000);
  const user = await c.env.DB.prepare("SELECT captcha_verified_at FROM users WHERE id = ?1").bind(userId).first<{ captcha_verified_at: number | null }>();
  if (user?.captcha_verified_at) return c.json({ correct: true, verified: true, me: await meView(c) });
  const row = await c.env.DB.prepare("SELECT operand_a, operand_b, answer, choices, attempts, updated_at FROM captcha_challenges WHERE user_id = ?1")
    .bind(userId).first<{ operand_a: number; operand_b: number; answer: number; choices: string; attempts: number; updated_at: number }>();
  if (!row) return c.json({ correct: false, ...await currentChallenge(c.env, userId) });
  if (row.attempts >= 5 && now - row.updated_at < 3600) return err(c, 429, "CAPTCHA_LOCKED", { retryAt: row.updated_at + 3600 });
  // Prevent parallel guesses from racing the five-attempt counter. The client already disables the buttons while busy.
  const attemptSlot = await c.env.DB.prepare(
    "UPDATE captcha_challenges SET last_attempt_at = ?2 WHERE user_id = ?1 AND updated_at = ?3 AND attempts = ?4 AND (last_attempt_at IS NULL OR last_attempt_at <= ?2 - 1)",
  ).bind(userId, now, row.updated_at, row.attempts).run();
  if (!attemptSlot.meta.changes) return err(c, 429, "TRY_AGAIN");
  if (answer === row.answer) {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET captcha_verified_at = ?2 WHERE id = ?1 AND captcha_verified_at IS NULL").bind(userId, now),
      c.env.DB.prepare("DELETE FROM captcha_challenges WHERE user_id = ?1").bind(userId),
    ]);
    const updated = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(userId).first<UserRow>();
    c.set("user", updated!);
    return c.json({ correct: true, verified: true, me: await meView(c) });
  }
  const attempts = row.attempts + 1;
  if (attempts >= 5) {
    await c.env.DB.prepare("UPDATE captcha_challenges SET attempts = 5, updated_at = ?2 WHERE user_id = ?1").bind(userId, now).run();
    return c.json({ correct: false, verified: false, locked: true, attemptsLeft: 0, retryAt: now + 3600 });
  }
  const next = makeMathChallenge();
  await c.env.DB.prepare(`UPDATE captcha_challenges SET operand_a=?2, operand_b=?3, answer=?4, choices=?5, attempts=?6, updated_at=?7 WHERE user_id=?1`)
    .bind(userId, next.a, next.b, next.answer, JSON.stringify(next.choices), attempts, now).run();
  return c.json({ correct: false, verified: false, locked: false, a: next.a, b: next.b, choices: next.choices, attemptsLeft: 5 - attempts });
});

/** Lists membership states for the current configured join requirements. */
app.get("/communities/status", async (c) => {
  if (!c.get("user").captcha_verified_at) return err(c, 403, "CAPTCHA_REQUIRED");
  return c.json({ communities: await communityStatuses(c.env, c.get("settings"), c.get("user").id) });
});

/** Creates a unique single-use private invite link for one configured group/channel. */
app.post("/communities/:index/invite", async (c) => {
  if (!c.get("user").captcha_verified_at) return err(c, 403, "CAPTCHA_REQUIRED");
  const s = c.get("settings");
  const list = requiredCommunities(s);
  const index = Number(c.req.param("index"));
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return err(c, 404, "NOT_FOUND");
  const chat = list[index];
  try {
    const status = await communityStatuses(c.env, s, c.get("user").id);
    if (status[index]?.joined) return c.json({ joined: true, url: null, private: true });
    const now = Math.floor(Date.now() / 1000);
    const existing = await c.env.DB.prepare(
      "SELECT invite_link, expires_at FROM community_invites WHERE user_id = ?1 AND community_id = ?2",
    ).bind(c.get("user").id, chat.id).first<{ invite_link: string; expires_at: number }>();
    if (existing && existing.expires_at > now + 60) return c.json({ url: existing.invite_link, private: true });
    const invite = await tg<{ invite_link: string }>(c.env.BOT_TOKEN, "createChatInviteLink", {
      chat_id: chat.id, name: `${brandName(s)} ${c.get("user").id}`.slice(0, 32), expire_date: now + 1800, member_limit: 1,
    });
    await c.env.DB.prepare(`INSERT INTO community_invites (user_id, community_id, invite_link, expires_at, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(user_id, community_id) DO UPDATE SET invite_link=excluded.invite_link,
      expires_at=excluded.expires_at, created_at=excluded.created_at`)
      .bind(c.get("user").id, chat.id, invite.invite_link, now + 1800, now).run();
    return c.json({ url: invite.invite_link, private: true });
  } catch (e) {
    console.warn("private invite creation failed", (e as Error).message);
    return err(c, 503, "INVITE_UNAVAILABLE", { message: "The bot must be an administrator in this community with invite-link permission." });
  }
});

/** The Verify button on the join-community step */
app.post("/channel/verify", async (c) => {
  if (!c.get("user").captcha_verified_at) return err(c, 403, "CAPTCHA_REQUIRED");
  let result;
  try {
    result = await verifyChannel(c.env, c.get("settings"), c.get("user").id);
  } catch (e) {
    if (e instanceof RetryLater) return err(c, 429, "TRY_AGAIN");
    throw e;
  }
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(c.get("user").id).first<UserRow>();
  c.set("user", user!);
  // An unavailable membership check keeps an unverified user gated; they can retry once Telegram responds.
  return c.json({ result, me: await meView(c) });
});

/** Called once when the home screen first shows: completes a pending referral */
app.post("/me/home", async (c) => {
  const s = c.get("settings");
  const u = c.get("user");
  if (u.lang === null || !u.terms_accepted_at) return c.json({ ok: false });
  if (await channelGateRequired(c.env, s, u)) return err(c, 403, "CHANNEL_REQUIRED");
  await onHomeReached(c.env, s, (p) => c.executionCtx.waitUntil(p), u.id);
  return c.json({ ok: true });
});

// Coupon redemption is atomic and once-per-user; balance and ledger are credited only after a limited-use claim succeeds.
app.post("/coupon/redeem", async (c) => {
  if (await channelGateRequired(c.env, c.get("settings"), c.get("user"))) return err(c, 403, "CHANNEL_REQUIRED");
  const body = await readBody<{ code?: unknown }>(c);
  const code = typeof body?.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return err(c, 400, "COUPON_INVALID");
  const now = Math.floor(Date.now() / 1000), userId = c.get("user").id;
  const result = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO coupon_redemptions (code, user_id, amount, redeemed_at)
      SELECT code, ?2, amount, ?3 FROM coupons WHERE code = ?1 AND enabled = 1 AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?3)
      ON CONFLICT(code, user_id) DO NOTHING`).bind(code, userId, now),
    c.env.DB.prepare("UPDATE coupons SET uses = uses + 1 WHERE code = ?1 AND changes() = 1").bind(code),
    c.env.DB.prepare(`INSERT INTO ledger (user_id, delta, kind, ref, note, created_at)
      SELECT ?2, amount, 'coupon', NULL, ?1, ?3 FROM coupon_redemptions WHERE code = ?1 AND user_id = ?2 AND changes() = 1`).bind(code, userId, now),
    c.env.DB.prepare("UPDATE users SET balance = balance + (SELECT amount FROM coupon_redemptions WHERE code = ?2 AND user_id = ?1) WHERE id = ?1 AND changes() = 1").bind(userId, code),
  ]);
  if (!result[0].meta.changes) {
    const existing = await c.env.DB.prepare("SELECT 1 AS yes FROM coupon_redemptions WHERE code = ?1 AND user_id = ?2").bind(code, userId).first<{ yes: number }>();
    const coupon = await c.env.DB.prepare("SELECT enabled, uses, max_uses AS maxUses, expires_at AS expiresAt FROM coupons WHERE code = ?1")
      .bind(code).first<{ enabled: number; uses: number; maxUses: number; expiresAt: number | null }>();
    const failure = couponFailureCode({ alreadyRedeemed: !!existing, coupon, now });
    return err(c, failure === "COUPON_ALREADY_USED" ? 409 : 400, failure);
  }
  const row = await c.env.DB.prepare("SELECT amount FROM coupon_redemptions WHERE code = ?1 AND user_id = ?2").bind(code, userId).first<{ amount: number }>();
  const freshUser = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?1").bind(userId).first<UserRow>();
  c.set("user", freshUser!);
  return c.json({ ok: true, amount: row?.amount ?? 0, balance: freshUser?.balance ?? 0, me: await meView(c) });
});

app.get("/referrals", async (c) => c.json(await referralStats(c.env, c.get("settings"), c.get("user").id)));

app.get("/terms", (c) => c.json({ terms: c.get("settings").terms_text }));

app.patch("/me", async (c) => {
  const b = await readBody<{ lang?: string | null; notify?: boolean; canMessage?: boolean; acceptTerms?: boolean }>(c);
  if (!b) return err(c, 400, "INVALID_BODY");
  const u = c.get("user");
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (b.lang !== undefined) {
    if (b.lang !== null && !(LANGS as readonly string[]).includes(b.lang)) return err(c, 400, "INVALID_LANG");
    sets.push("lang = ?");
    vals.push(b.lang);
  }
  if (b.notify !== undefined) sets.push(`notify = ${b.notify ? 1 : 0}`);
  if (b.canMessage) sets.push("can_message = 1");
  if (b.acceptTerms) sets.push(`terms_accepted_at = COALESCE(terms_accepted_at, ${Math.floor(Date.now() / 1000)})`);
  if (sets.length) {
    const row = await c.env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ? RETURNING *`).bind(...vals, u.id).first<UserRow>();
    c.set("user", row!);
    c.set("lang", pickLang(row!.lang ?? row!.language_code));
  }
  return c.json(await meView(c));
});

// ---- Catalog ----

const cacheable = (c: C) => c.header("cache-control", "private, max-age=60");

app.get("/catalog/platforms", async (c) => {
  cacheable(c);
  return c.json(await listPlatforms(c.env, c.get("settings")));
});

app.get("/catalog/categories", async (c) => {
  cacheable(c);
  return c.json(await listCategories(c.env, c.get("settings"), c.req.query("platform") ?? ""));
});

app.get("/catalog/services", async (c) => {
  cacheable(c);
  const page = pageParam(c.req.query("page"));
  return c.json(await listServices(c.env, c.get("settings"), c.get("lang"), c.req.query("platform") ?? "", c.req.query("category") ?? "", page));
});

app.get("/catalog/search", async (c) => {
  c.header("cache-control", "private, max-age=120");
  return c.json(await searchServices(c.env, c.get("settings"), c.get("lang"), c.req.query("q") ?? ""));
});

app.get("/catalog/service/:id", async (c) => {
  const svc = await getService(c.env, c.get("settings"), c.get("lang"), Number(c.req.param("id")));
  if (!svc) return err(c, 404, "SERVICE_NOT_FOUND");
  const { cost: _cost, ...pub } = svc;
  return c.json(pub);
});

// ---- Orders ----

async function draftFor(c: C, draft: OrderDraft) {
  const svc = await getService(c.env, c.get("settings"), c.get("lang"), Number(draft.serviceId));
  if (!svc) throw new OrderError("SERVICE_NOT_FOUND");
  const check = checkDraft({ ...svc, type_key: svc.typeKey, dripfeed: !!svc.dripFeed, dripMax: svc.dripFeed?.max_total_minutes ?? null }, draft);
  if ("error" in check) throw new OrderError(check.error, check.details);
  return { svc, check, charge: orderCharge(svc.rate, check.quantity, svc.quantityMode) };
}

function orderErr(c: C, e: unknown) {
  if (e instanceof TooManyInvoices) return err(c, 429, "TOO_MANY_REQUESTS");
  if (e instanceof OrderError) return err(c, e.code === "INSUFFICIENT_FUNDS" ? 402 : 400, e.code, e.details);
  throw e;
}

app.post("/orders", async (c) => {
  if (await channelGateRequired(c.env, c.get("settings"), c.get("user"))) return err(c, 403, "CHANNEL_REQUIRED");
  const draft = await readBody<OrderDraft & { payWith?: unknown }>(c);
  if (!draft || typeof draft.link !== "string") return err(c, 400, "INVALID_BODY");
  // Order checkout spends the USD wallet balance. Telegram Stars are used only in /wallet/topup.
  if (draft.payWith !== undefined && draft.payWith !== "balance") return err(c, 400, "INVALID_PAYMENT_METHOD");
  try {
    const { svc, check } = await draftFor(c, draft);
    const link = draft.link.trim();
    const o = await placeOrder(c.env, c.get("user").id, svc, link, check.quantity, check.fields, draft.dripMinutes, (task) => c.executionCtx.waitUntil(task));
    return c.json({ order: orderView(o) });
  } catch (e) {
    return orderErr(c, e);
  }
});

app.get("/orders", async (c) => {
  const u = c.get("user");
  const filter = c.req.query("filter") ?? "all";
  const q = (c.req.query("q") ?? "").trim();
  const before = cursorParam(c.req.query("before"));
  const where = ["user_id = ?1", "id < ?2"];
  const vals: unknown[] = [u.id, before];
  if (filter === "active") where.push("status IN ('submitting','pending','processing','in_progress')");
  if (filter === "finished") where.push("status IN ('completed','partial','cancelled','failed')");
  if (q) {
    vals.push(`%${q.replace(/^#/, "")}%`);
    where.push(`(CAST(COALESCE(np_order_id, id) AS TEXT) LIKE ?3 OR link LIKE ?3 OR service_name LIKE ?3)`);
  }
  const { results } = await c.env.DB.prepare(`SELECT * FROM orders WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT 30`)
    .bind(...vals)
    .all<OrderRow>();
  const starIds = await paidWithStars(c.env, results.map((o) => o.id));
  return c.json(results.map((o) => orderView(o, starIds.has(o.id))));
});

async function paidWithStars(env: Env, ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const { results } = await env.DB.prepare("SELECT order_id FROM payments WHERE order_id IN (SELECT value FROM json_each(?1))")
    .bind(JSON.stringify(ids))
    .all<{ order_id: number }>();
  return new Set(results.map((r) => r.order_id));
}

async function ownOrder(c: C): Promise<OrderRow | null> {
  const o = await getOrderRow(c.env, Number(c.req.param("id")));
  return o && o.user_id === c.get("user").id ? o : null;
}

app.get("/orders/:id", async (c) => {
  let o = await ownOrder(c);
  if (!o) return err(c, 404, "ORDER_NOT_FOUND");
  // Re-ask NotPanel at most every 90 s (20 s while the order is still being submitted); webhooks and cron cover the rest
  if (Date.now() / 1000 - o.checked_at > (o.status === "submitting" ? 20 : 90)) o = await refreshOrder(c.env, o);
  const stars = await paidWithStars(c.env, [o.id]);
  return c.json(orderView(o, stars.has(o.id)));
});

app.post("/orders/:id/cancel", async (c) => {
  const o = await ownOrder(c);
  if (!o) return err(c, 404, "ORDER_NOT_FOUND");
  try {
    return c.json(orderView(await cancelOrder(c.env, o)));
  } catch (e) {
    return orderErr(c, e);
  }
});

app.post("/orders/:id/refill", async (c) => {
  const o = await ownOrder(c);
  if (!o) return err(c, 404, "ORDER_NOT_FOUND");
  try {
    return c.json(orderView(await refillOrder(c.env, o)));
  } catch (e) {
    return orderErr(c, e);
  }
});

// ---- Wallet ----

app.get("/wallet", async (c) => {
  const u = c.get("user");
  const before = cursorParam(c.req.query("before"));
  const { results } = await c.env.DB.prepare(
    `SELECT l.id, l.delta, l.kind, l.ref, l.note, l.created_at, COALESCE(o.np_order_id, o.id) AS order_number
     FROM ledger l LEFT JOIN orders o ON o.id = l.ref AND l.kind IN ('order','refund')
     WHERE l.user_id = ?1 AND l.id < ?2 ORDER BY l.id DESC LIMIT 30`,
  )
    .bind(u.id, before)
    .all<{ id: number; delta: number; kind: LedgerItem["kind"]; ref: number | null; note: string | null; created_at: number; order_number: number | null }>();
  return c.json({
    balance: u.balance,
    items: results.map((r) => ({ id: r.id, delta: r.delta, kind: r.kind, ref: r.ref, orderNumber: r.kind === "order" || r.kind === "refund" ? r.order_number ?? r.ref : null, note: r.note, createdAt: r.created_at })),
  });
});

/** Public receiving instructions only; secrets are never returned here. Empty admin config means unavailable. */
app.get("/wallet/manual-payment-options", (c) => {
  const s = c.get("settings");
  const cryptoInstructions = manualPaymentInstructions("crypto", s);
  const bankInstructions = manualPaymentInstructions("bank_transfer", s);
  return c.json({
    crypto: { available: !!cryptoInstructions, instructions: cryptoInstructions },
    bank_transfer: { available: !!bankInstructions, instructions: bankInstructions },
  });
});

/** Creates a manual payment request. Funds are credited only after an owner approves the submitted reference. */
app.post("/wallet/manual-payments", async (c) => {
  const b = await readBody<{ method?: unknown; amount?: unknown; reference?: unknown }>(c);
  if (!b || (b.method !== "crypto" && b.method !== "bank_transfer")) return err(c, 400, "INVALID_BODY");
  const s = c.get("settings");
  // Use the same structured/legacy config resolution as the public options endpoint.
  // Otherwise the UI may show a new structured config that submission rejects.
  if (!manualPaymentInstructions(b.method, s)) return err(c, 503, "NO_PAYMENT_AVAILABLE");
  const amount = Number(b.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return err(c, 400, "INVALID_AMOUNT");
  if (!validDepositAmountMicroUsd(amount)) return err(c, 400, "MINIMUM_DEPOSIT", { minUsd: (MINIMUM_DEPOSIT_MICRO_USD / 1_000_000).toFixed(2) });
  const rawReference = typeof b.reference === "string" ? b.reference : "";
  if (rawReference.length > 240) return err(c, 400, "INVALID_BODY");
  const reference = rawReference.trim();
  if (b.method === "crypto" && reference.length < 4) return err(c, 400, "PAYMENT_REFERENCE_REQUIRED");
  const now = Math.floor(Date.now() / 1000);
  let row: { id: number } | null;
  try {
    row = await c.env.DB.prepare(
      `INSERT INTO manual_payment_requests (user_id, method, amount, reference, status, created_at)
       VALUES (?1, ?2, ?3, ?4, 'pending', ?5) RETURNING id`,
    ).bind(c.get("user").id, b.method, amount, reference, now).first<{ id: number }>();
  } catch (e) {
    if (/manual_payment_reference_unique|UNIQUE constraint failed/i.test((e as Error).message)) return err(c, 409, "PAYMENT_REFERENCE_USED");
    throw e;
  }
  if (!row) throw new Error("Manual payment request insert did not return an ID");
  c.executionCtx.waitUntil(notifyManualPaymentAdmins(c.env, row.id).catch((e) => console.warn("manual payment admin notice failed", row.id, (e as Error).message)));
  return c.json({ id: row.id, status: "pending" }, 201);
});

app.post("/wallet/topup", async (c) => {
  if (await channelGateRequired(c.env, c.get("settings"), c.get("user"))) return err(c, 403, "CHANNEL_REQUIRED");
  const b = await readBody<{ stars: number }>(c);
  if (!b) return err(c, 400, "INVALID_BODY");
  const s = c.get("settings");
  // Whole Stars only
  const stars = Number(b.stars);
  const max = Math.min(s.max_topup_stars, MAX_STARS_PER_PAYMENT);
  const minUsdStars = Math.ceil(s.stars_per_usd);
  if (!Number.isInteger(stars) || stars < Math.max(s.min_topup_stars, minUsdStars) || stars > max)
    return err(c, 400, "INVALID_AMOUNT", { min: starsText(Math.max(s.min_topup_stars, minUsdStars)), max: starsText(max) });
  try {
    const inv = await createInvoice(c.env, c.get("user").id, c.get("lang"), stars, s.stars_per_usd, null);
    return c.json({ invoice: inv.link, stars: inv.stars, paymentId: inv.paymentId });
  } catch (e) {
    if (e instanceof TooManyInvoices) return err(c, 429, "TOO_MANY_REQUESTS");
    throw e;
  }
});

app.get("/payments/:id", async (c) => {
  const p = await c.env.DB.prepare("SELECT id, status, order_id FROM payments WHERE id = ?1 AND user_id = ?2")
    .bind(Number(c.req.param("id")), c.get("user").id)
    .first<{ id: number; status: string; order_id: number | null }>();
  if (!p) return err(c, 404, "NOT_FOUND");
  return c.json({ id: p.id, status: p.status, orderId: p.order_id, balance: c.get("user").balance });
});
