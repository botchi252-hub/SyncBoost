# SyncBoost: your own SMM shop inside Telegram

SyncBoost is a Telegram bot and Mini App that sells social media growth services (followers, views, likes and more
for Telegram, Instagram, TikTok, YouTube, X and 30+ platforms). The wallet is denominated in **US dollars**, while
Telegram Stars are the checkout method currently available for deposits and direct order payments. Prices show both
USD and their Star equivalent. Orders are fulfilled automatically by [NotPanel](https://notpanel.com) through your
own NotPanel API key. You set the prices; the markup is your profit.

It runs on **Cloudflare's free plan** and deploys in a few clicks. Name, logo, colors and links are yours to set.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/rehul888/notbot)

<p align="center">
  <img src="docs/screenshots/hero.webp" alt="SyncBoost Mini App: home screen, order form and order tracking" width="100%">
</p>

## Features

- **Full shop in a Mini App**: browse platform → category → service, order form with every NotPanel option,
  order tracking, wallet, refunds, order history, referral program.
- **USD wallet + payment choices**: deposit to your dollar balance with Telegram Stars, or use optional admin-configured crypto and bank-transfer instructions. Manual payment references are reviewed by an admin before the wallet is credited; an unconfigured method shows “No payment available.”
- **Anti-abuse onboarding**: a one-time three-choice arithmetic check, followed by terms and configured community checks.
- **Flexible join gate**: configure up to 20 required groups/channels in the admin panel; each Join button requests a one-use invite link and membership is checked again before access.
- **Coupons**: create limited-use promo codes in the admin panel and credit the user's USD wallet when redeemed.
- **Automatic catalog and prices**: services, categories and prices sync from NotPanel on a schedule. New services
  can go on sale automatically; services NotPanel removes or pauses are taken off sale.
- **Your pricing**: default markup, per platform, per category or per service, or a fixed price per service.
- **Live order updates and provider recovery**: instant NotPanel webhooks plus a once-a-minute check. If the provider
  rejects an order because the API key, account balance, or provider service is unavailable, the bot alerts admins with
  **Fixed** (retry the same order using its original request ID) and **Not fixed** (stop and refund the customer's
  wallet). Repeated reviews/refunds are guarded against duplicates.
- **White-label branding**: your name, logo, welcome banner, 10 color themes or any custom color, website and terms
  links, custom welcome text, optional Telegram Premium custom emojis in bot messages.
- **20 languages** for customers (English, Español, Português, Русский, Türkçe, العربية, हिन्दी, Indonesia, Français,
  中文, Deutsch, Italiano, Polski, Українська, 日本語, 한국어, Tiếng Việt, فارسی, اردو, বাংলা).
- **Admin panel inside Telegram**: sales and profit, orders, users and balances, Stars payments/refunds, manual crypto
  and bank-transfer requests, provider issue recovery, referrals, coupons, price changes, branding, admins and settings.
- **Referral rewards in USD**: the default reward is $2 per qualified referral, editable in settings.

<p align="center">
  <img src="docs/screenshots/app.webp" alt="Home, services list, order form and orders screens" width="100%">
  <img src="docs/screenshots/more.webp" alt="Wallet and profile screens, and the app in dark mode" width="100%">
</p>

## What you need

1. A **Telegram bot**: open [@BotFather](https://t.me/BotFather), send `/newbot`, and copy the token.
2. A **NotPanel account and API key**: sign up on [notpanel.com](https://notpanel.com) and create an API key on the
   [developers page](https://notpanel.com/developers). Add funds there: your orders are paid from that balance.
3. A free **Cloudflare** account and a **GitHub** account.

## Deploy in one click

1. Click **Deploy to Cloudflare** above and sign in.
2. Cloudflare copies this project to your GitHub, creates the database and asks for:
   - `BOT_TOKEN`: your bot token from @BotFather.
   - `NOTPANEL_API_KEY`: your NotPanel API key (starts with `np_live_`).
   - `OWNER_IDS` (optional): your Telegram user ID, if you want to be admin straight away. Leave it empty to claim
     admin in the next step instead.
3. When the deploy finishes, open your app's address (for example `https://notbot.<you>.workers.dev`).
4. The setup page asks for your bot token once (to prove the bot is yours), checks your NotPanel key, and sets up
   everything in Telegram for you: webhook, the **Open App** button, commands, and the bot's name and description
   in all languages.
5. Tap **Claim admin**. Telegram opens your bot with a one-time code, and you're the admin.
6. Open your bot, tap **Open App**, then **Profile → Admin** to set your markup, branding and links. The first
   catalog sync takes about 20 minutes.

That's it. Telegram Stars payments need no extra setup.

<p align="center">
  <img src="docs/screenshots/owner.webp" alt="The one-time setup page and the admin Branding page" width="60%">
</p>

> **Note:** a few profile options can only be set in @BotFather (the bot's profile photo, and making the Mini App the
> bot's "main app"). They're optional.

## Customize

Everything is in the admin panel (Telegram → your bot → Open App → Profile → Admin). Pick a ready-made color theme
or any color you like; the whole app, light and dark, follows it:

<p align="center">
  <img src="docs/screenshots/themes.webp" alt="The same home screen in five color themes: cobalt, violet, emerald, sunset and rose in dark mode" width="100%">
</p>

| Where | What |
|---|---|
| Branding | Name, logo, welcome banner, color theme (10 presets or any color), website, terms link, welcome text, Premium custom emojis and button icons. "Update bot name & description in Telegram" applies the new name to the bot's profile. |
| Services & prices | Markup per platform / category / service, fixed prices, show or hide anything. |
| Settings | Stars-to-USD credit rate, top-up limits, 40% default markup, price sync, support usernames, crypto receiving instructions, bank-transfer instructions, required groups/channels, USD referral reward and daily cap, terms text, NotPanel API key, admins. |
| Manual payment requests | Review submitted crypto transaction hashes / bank references. Only approve after checking your actual payment account; approval credits the USD wallet once. |
| Coupons & promo codes | Create, pause and manage limited-use USD wallet credits. |

## How money works

- Money is stored as integer **USD micro-units**. Wallet balances are shown in dollars; catalog prices show dollars and
  the equivalent whole-Star amount. Telegram Stars remain the invoice currency for digital goods.
- The default is **77 Stars per $1 wallet credit** (roughly $0.013 per Star, aligned with approximate creator payout,
  not a universal retail purchase price). Change this in Admin → Settings & connection if your realized payout differs.
  Retail Stars prices vary by country, app store and purchase channel, so this setting is intentionally editable.
- Keep your NotPanel balance topped up and your API key active. If a provider/account error prevents an order from being placed, the order is held for an admin decision instead of being silently refunded; the admin can retry after fixing the issue or refund once if it cannot be resolved.
- Crypto and bank-transfer requests are not verified automatically. Do not approve one until you have independently confirmed the payment; wallet credit happens only on approval.
- Referral rewards and coupon credits are added to the USD wallet.

## Update your copy

Your copy lives in your own GitHub repository. To get a new version, pull this repository into yours and push;
Cloudflare redeploys automatically and applies database updates:

```bash
git remote add upstream https://github.com/rehul888/notbot.git   # once
git pull upstream main
git push
```

## Develop locally

```bash
npm install
cp .dev.vars.example .dev.vars   # add your keys; add DEV_FAKE_USER_ID=1 and OWNER_IDS=1 to open it in a browser
npm run db:migrate:local
npm run dev                      # http://localhost:5173
```

Local development never places real NotPanel orders unless `ALLOW_LIVE_ORDERS=1` is set in `.dev.vars`.
Checks: `npm run typecheck && npm test && npm run build`.

Manual deploy without the button: `npx wrangler d1 create notpanel` (put the id in `wrangler.jsonc`),
`npx wrangler secret put BOT_TOKEN`, `npx wrangler secret put NOTPANEL_API_KEY`, then `npm run deploy` and open your
app's address to finish setup.

## Project layout

| Path | What |
|---|---|
| `src/` | Mini App (Preact + Vite): screens, admin panel, setup page, translations. |
| `worker/` | Cloudflare Worker (Hono): app API, setup, bot webhook, NotPanel webhook, cron jobs. |
| `shared/` | Code shared by both sides: types, money conversion, branding and themes. |
| `migrations/` | D1 database schema. |

## License

SyncBoost is **source-available** under the [NotBot License (NotPanel-only)](LICENSE): free to use, modify, deploy and
run commercially, **only with the NotPanel API**. It is not an OSI open source license. The app checks every API key
with NotPanel before using it.

Security issues: see [SECURITY.md](SECURITY.md).


## SyncBoost deployment notes

Use Node 24 (see `.nvmrc`), run `npm ci`, `npm run typecheck`, `npm test`, and `npm run deploy`. The deployment script builds the app, applies D1 migrations remotely, and deploys the Worker. Configure required communities in Admin → Settings & connection → Join requirements (one `chat ID | display name` or `@publicname | display name` per line). The bot needs administrator and invite-link permissions in each community. After deployment, use **Reconnect bot & NotPanel updates** so Telegram sends `chat_member` updates. Up to 20 communities are supported. Coupons are managed in Admin → Coupons & promo codes.
