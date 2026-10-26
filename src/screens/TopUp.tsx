import { Fragment, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, pollDelay } from "../api";
import { ArtTopUpSuccess } from "../art";
import { starsCredit, starsToCover } from "../../shared/stars";
import { balance, money, num, stars } from "../format";
import { t, type Key } from "../i18n";
import { Icon } from "../icons";
import { refreshMe } from "../me";
import { Confetti, reducedMotion } from "../motion";
import { back, navigate, useRoute } from "../router";
import { meStore } from "../store";
import { haptic, openInvoice } from "../tg";
import { BackNav, BottomButtons, Field, LargeTitle, List, Notice, Num, Presets, Row, Screen, Section, errText, toast } from "../ui";

const PRESETS_CENTS = [100, 200, 500, 1000, 2000, 5000, 10000];
const CUSTOM = -1;
const DEFAULT_USD_CENTS = 325;
const at = (ms: number) => `--d:${ms}ms`;

/** t() with nodes (e.g. <Num>) dropped into the sentence, so each language keeps its own word order. */
function tn(key: Key, vars: Record<string, ComponentChildren>): ComponentChildren {
  const marks: Record<string, string> = {};
  for (const k in vars) marks[k] = `\u0001${k}\u0001`;
  return t(key, marks).split("\u0001").map((part, i) => (i % 2 ? <Fragment key={i}>{vars[part]}</Fragment> : part));
}

/** Route prefills from OrderForm are still in Stars; convert them to their USD wallet equivalent. */
function prefill(v: string | null, rate: number, min: number, max: number): string {
  const starsWanted = v && /^\d{1,7}$/.test(v) ? Number(v) : DEFAULT_USD_CENTS / 100 * rate;
  const cents = Math.round((starsWanted / Math.max(1, rate)) * 100);
  const minCents = Math.ceil((min / Math.max(1, rate)) * 100);
  const maxCents = Math.floor((max / Math.max(1, rate)) * 100);
  return (Math.min(Math.max(cents, minCents), maxCents) / 100).toFixed(2);
}

function safeRet(v: string | null): string | null {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : null;
}
type Done = { added: number; oldBalance: number; paymentId: number; confirmed: boolean };
type ManualMethod = "crypto" | "bank_transfer";
type ManualOption = { available: boolean; instructions: string };
type ManualPaymentOptions = { crypto: ManualOption; bank_transfer: ManualOption };


/** USD-first wallet top-up. Telegram Stars remain the actual invoice currency required for digital goods. */
export function TopUp() {
  const { query } = useRoute();
  const ret = safeRet(query.get("ret"));
  const [done, setDone] = useState<Done | null>(null);
  return <><BackNav to={ret ?? "/wallet"} />{done ? <TopUpSuccess {...done} ret={ret} /> : <TopUpForm initial={query.get("amount")} onDone={setDone} backTo={ret ?? "/wallet"} />}</>;
}

function TopUpForm({ initial, onDone, backTo }: { initial: string | null; onDone: (d: Done) => void; backTo: string }) {
  const me = meStore.use()!;
  const [text, setText] = useState(() => prefill(initial, me.starsPerUsd, me.minTopup, me.maxTopup));
  const [busy, setBusy] = useState(false);
  const [manualBusy, setManualBusy] = useState(false);
  const [showErr, setShowErr] = useState(false);
  const [manualOptions, setManualOptions] = useState<ManualPaymentOptions | null>(null);
  const [paymentChoice, setPaymentChoice] = useState<"stars" | ManualMethod | null>(null);
  const [manualMethod, setManualMethod] = useState<ManualMethod | null>(null);
  const [manualReference, setManualReference] = useState("");
  const [manualRequestId, setManualRequestId] = useState<number | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    api<ManualPaymentOptions>("/wallet/manual-payment-options").then((r) => { if (live) setManualOptions(r); }).catch(() => { if (live) setManualOptions({ crypto: { available: false, instructions: "" }, bank_transfer: { available: false, instructions: "" } }); });
    return () => { live = false; };
  }, []);
  const amountUsd = Number(text) || 0;
  const cents = Math.round(amountUsd * 100);
  const starAmount = starsToCover(cents * 10_000, me.starsPerUsd);
  const validFormat = /^\d{1,5}(?:\.\d{1,2})?$/.test(text);
  const minimumStars = Math.max(me.minTopup, Math.ceil(me.starsPerUsd));
  const validUsd = validFormat && amountUsd >= 1;
  const valid = validUsd && starAmount >= minimumStars && starAmount <= me.maxTopup;
  const err = showErr && (paymentChoice === "stars" ? !valid : !validUsd);
  const presets = PRESETS_CENTS.filter((c) => {
    const n = starsToCover(c * 10_000, me.starsPerUsd);
    return n >= minimumStars && n <= me.maxTopup;
  });

  const pay = async () => {
    if (busy) return;
    if (!valid) {
      setShowErr(true);
      haptic.error();
      input.current?.focus();
      input.current?.scrollIntoView({ block: "center", behavior: reducedMotion() ? "auto" : "smooth" });
      return;
    }
    haptic.press();
    setBusy(true);
    const oldBalance = me.balance;
    try {
      const r = await api<{ invoice: string; stars: number; paymentId: number }>("/wallet/topup", { body: { stars: starAmount } });
      const status = await openInvoice(r.invoice);
      if (status === "paid") {
        let confirmed = false;
        for (let i = 0; i < 5; i++) {
          const p = await api<{ status: string }>(`/payments/${r.paymentId}`).catch(() => null);
          if (p?.status === "paid") { confirmed = true; break; }
          if (i === 1) toast(t("topup.waiting"));
          await new Promise((res) => setTimeout(res, pollDelay(i)));
        }
        await refreshMe().catch(() => {});
        onDone({ added: starsCredit(r.stars, me.starsPerUsd), oldBalance, paymentId: r.paymentId, confirmed });
        return;
      }
    } catch (e) {
      toast(errText(e), "error");
    }
    setBusy(false);
  };

  const submitManual = async () => {
    if (!manualMethod || manualBusy) return;
    const option = manualOptions?.[manualMethod];
    if (!option?.available) {
      toast(t("topup.noPaymentAvailable"), "error");
      return;
    }
    if (!validUsd) {
      setShowErr(true);
      toast(t("topup.minimumDepositError"), "error");
      input.current?.focus();
      return;
    }
    const reference = manualReference.trim();
    if (manualMethod === "crypto" && (reference.length < 4 || reference.length > 240)) {
      toast(t("err.PAYMENT_REFERENCE_REQUIRED"), "error");
      return;
    }
    setManualBusy(true);
    try {
      const r = await api<{ id: number }>("/wallet/manual-payments", {
        body: { method: manualMethod, amount: cents * 10_000, ...(reference ? { reference } : {}) },
      });
      setManualRequestId(r.id);
      setManualMethod(null);
      setPaymentChoice(null);
      setManualReference("");
      toast(t("topup.manualSubmitted", { id: r.id }), "ok");
    } catch (e) {
      toast(errText(e), "error");
    }
    setManualBusy(false);
  };

  const selectedOption = manualMethod && manualOptions ? manualOptions[manualMethod] : null;
  const supportContacts = [me.supportUsername, me.supportUsername2]
    .filter((username): username is string => !!username && !!username.trim())
    .map((username) => `@${username.trim().replace(/^@/, "")}`)
    .join(" / ");
  const supportSuffix = supportContacts ? ` (${supportContacts})` : "";

  const onInput = (e: Event) => {
    const el = e.currentTarget as HTMLInputElement;
    const clean = el.value.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1").replace(/^0+(?=\d)/, "").slice(0, 8);
    if (clean !== el.value) el.value = clean;
    setText(clean);
    setShowErr(false);
  };
  const selectedPreset = presets.find((p) => p === cents) ?? CUSTOM;

  return (
    <Screen bottom="native" overlay={<BottomButtons main={paymentChoice === "stars" ? { text: t("topup.pay", { stars: num(starAmount > 0 ? starAmount : minimumStars) }), onClick: pay, progress: busy, shine: true, disabled: !valid } : manualMethod ? { text: t("topup.submitManual"), onClick: submitManual, progress: manualBusy, disabled: !selectedOption?.available || !validUsd || (manualMethod === "crypto" && manualReference.trim().length < 4) } : null} secondary={{ text: t("common.back"), onClick: () => paymentChoice ? (setPaymentChoice(null), setManualMethod(null)) : back(backTo) }} />}>
      <LargeTitle size="title" title={t("topup.title")} sub={tn("topup.balance", { amount: <Num>{balance(me.balance)}</Num> })} />
      <Section header={t("topup.otherPayment")}>
        <List>
          <Row icon="star" title={t("topup.starPayment")} meta={t("topup.note")} onClick={() => { setPaymentChoice("stars"); setManualMethod(null); }} />
          <Row icon="wallet" title={t("topup.cryptoTransfer")} meta={manualOptions ? (manualOptions.crypto.available ? t("topup.paymentConfigured") : t("topup.noPaymentAvailable")) : t("common.loading")} onClick={() => { setPaymentChoice("crypto"); setManualMethod("crypto"); setManualReference(""); }} />
          <Row icon="wallet" title={t("topup.bankTransfer")} meta={manualOptions ? (manualOptions.bank_transfer.available ? t("topup.paymentConfigured") : t("topup.noPaymentAvailable")) : t("common.loading")} onClick={() => { setPaymentChoice("bank_transfer"); setManualMethod("bank_transfer"); setManualReference(""); }} />
        </List>
      </Section>
      {paymentChoice ? <>
        <Section header={paymentChoice === "stars" ? t("topup.starPayment") : paymentChoice === "crypto" ? t("topup.cryptoTransfer") : t("topup.bankTransfer")}>
          {paymentChoice === "stars" ? <Notice tone="info">{t("topup.note")}</Notice> : selectedOption?.available ? <>
            <div class="card pad" style="white-space:pre-wrap;overflow-wrap:anywhere">{selectedOption.instructions}</div>
            {manualMethod === "crypto" ? <Field id="manual-payment-reference" label={t("topup.paymentReference")} value={manualReference} onInput={setManualReference} maxLength={240} placeholder={t("topup.paymentReference")} help={t("topup.referenceHelp")} /> : null}
            <Notice tone="warn">{t("topup.manualReviewPending", { support: supportSuffix })}</Notice>
          </> : <Notice tone="warn">{t("topup.noPaymentAvailable")}</Notice>}
        </Section>
        {paymentChoice === "stars" || selectedOption?.available ? <Section labelFor="amt" header={t("topup.amount")} footer={t("topup.minimumDeposit")}>
          <div class={err ? "card amount-card invalid" : "card amount-card"}>
            <div class="row1" dir="ltr">
              <span class="currency-symbol" aria-hidden="true">$</span>
              <input ref={input} id="amt" class="num-l" inputMode="decimal" pattern="[0-9.]*" enterKeyHint="done" dir="ltr" autoComplete="off" placeholder="1.00" aria-label={t("topup.amount")} value={text} aria-invalid={err ? true : undefined} aria-describedby={err ? "amt-err" : undefined} onInput={onInput} onBlur={() => setShowErr(!!text && !valid)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
            </div>
            {paymentChoice === "stars" ? <div class="note" dir="ltr">{money(Math.round(amountUsd * 1_000_000))} ≈ {stars(starAmount)}</div> : <div class="note" dir="ltr">{money(Math.round(amountUsd * 1_000_000))}</div>}
            {paymentChoice === "stars" ? <Presets value={selectedPreset} options={[...presets.map((p): [number, string] => [p, money(p * 10_000)]), [CUSTOM, t("topup.custom")]]} label={t("topup.amount")} onChange={(v) => { setShowErr(false); if (v === CUSTOM) { setText(""); input.current?.focus(); } else setText((v / 100).toFixed(2)); }} /> : null}
          </div>
          {err ? <p class="field-error" id="amt-err" role="alert"><Icon name="alert" size={15} stroke={2.2} /><span>{paymentChoice === "stars" ? t("topup.invalidUsd", { min: money(starsCredit(minimumStars, me.starsPerUsd)), max: money(starsCredit(me.maxTopup, me.starsPerUsd)) }) : t("topup.minimumDepositError")}</span></p> : null}
        </Section> : null}
      </> : null}
      {manualRequestId !== null ? <Notice tone="info">{t("topup.manualPending", { id: manualRequestId })} {t("topup.supportIfDelayed", { support: supportSuffix })}</Notice> : null}
    </Screen>
  );
}

function TopUpSuccess({ added, paymentId, confirmed, ret }: Done & { ret: string | null }) {
  const me = meStore.use()!;
  const currentBalance = me.balance;
  useEffect(() => {
    window.scrollTo(0, 0);
    const h = setTimeout(() => haptic.success(), 480);
    return () => clearTimeout(h);
  }, []);
  useEffect(() => {
    if (confirmed) return;
    let live = true;
    let tries = 0;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const p = await api<{ status: string }>(`/payments/${paymentId}`).catch(() => null);
      if (!live) return;
      if (p?.status === "paid") await refreshMe().catch(() => {});
      else if (Date.now() - started < 180_000) timer = setTimeout(check, pollDelay(tries++));
    };
    timer = setTimeout(check, pollDelay(tries++));
    return () => { live = false; clearTimeout(timer); };
  }, []);
  const main = ret ? { text: t("topup.backToOrder"), onClick: () => back(ret) } : { text: t("common.done"), onClick: () => navigate("/wallet", { replace: true }) };
  return (
    <Screen bottom="native" center overlay={<><Confetti n={10} delay={520} /><BottomButtons main={main} /></>}>
      <div class="success-art celebrate"><ArtTopUpSuccess /></div>
      <div class="rise" style={at(240)} role="status"><LargeTitle align="center" size="title" title={t("topup.successTitle")} sub={tn("topup.done", { amount: <Num>{money(added, { sign: true })}</Num> })} /></div>
      <div class="card pad new-balance rise" style={at(340)}><span>{t("topup.newBalance")}</span><b class="num-xl count" dir="ltr">{money(currentBalance)}</b></div>
    </Screen>
  );
}
