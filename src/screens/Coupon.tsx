import { useState } from "preact/hooks";
import { api } from "../api";
import { money } from "../format";
import { t } from "../i18n";
import { refreshMe } from "../me";
import { back, navigate } from "../router";
import { haptic } from "../tg";
import { BackNav, BottomButtons, Field, LargeTitle, Notice, Screen, errText, toast } from "../ui";

export function Coupon() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [credited, setCredited] = useState<number | null>(null);

  const redeem = async () => {
    const value = code.trim().toUpperCase();
    if (!value || busy || credited !== null) return;
    setBusy(true);
    haptic.press();
    try {
      const r = await api<{ ok: true; amount: number }>("/coupon/redeem", { body: { code: value } });
      setCredited(r.amount);
      setCode(value);
      await refreshMe();
      haptic.success();
      toast(t("coupon.success", { amount: money(r.amount) }), "ok");
    } catch (e) {
      haptic.error();
      toast(errText(e), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <BackNav to="/profile" />
      <Screen bottom="native" overlay={<BottomButtons main={credited !== null ? { text: t("common.done"), onClick: () => navigate("/wallet") } : { text: busy ? t("common.loading") : t("coupon.redeem"), onClick: redeem, progress: busy, disabled: !code.trim() }} secondary={{ text: t("common.back"), onClick: () => back("/profile") }} />}>
        <LargeTitle title={t("coupon.title")} sub={t("coupon.sub")} />
        <Field id="coupon-code" label={t("coupon.code")} value={code} onInput={(v) => setCode(v.toUpperCase().replace(/[^A-Z0-9_-]/g, "").slice(0, 32))} placeholder="SYNC-2026" maxLength={32} help={t("coupon.help")} />
        {credited !== null ? <Notice tone="info">{t("coupon.success", { amount: money(credited) })}</Notice> : null}
      </Screen>
    </>
  );
}
