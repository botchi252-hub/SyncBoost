import { useEffect, useState } from "preact/hooks";
import { api } from "../api";
import { ArtWelcome } from "../art";
import { t } from "../i18n";
import { refreshMe } from "../me";
import { meStore } from "../store";
import { haptic } from "../tg";
import { LargeTitle, List, Notice, Row, Screen, Skeleton, errText, toast } from "../ui";

type Challenge = {
  verified?: boolean;
  locked?: boolean;
  retryAt?: number;
  attemptsLeft?: number;
  a?: number;
  b?: number;
  choices?: number[];
};

/** One-time server-validated arithmetic check; a failed answer always rotates the question. */
export function MathCheck() {
  const me = meStore.use()!;
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const next = await api<Challenge>("/captcha");
      setChallenge(next);
      if (next.verified) await refreshMe();
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const choose = async (answer: number) => {
    if (busy || challenge?.locked || challenge?.verified) return;
    setBusy(true);
    haptic.tap();
    try {
      const result = await api<Challenge & { correct?: boolean; me?: typeof me }>("/captcha/verify", { body: { answer } });
      setChallenge(result);
      if (result.correct && result.verified) {
        haptic.success();
        await refreshMe();
      } else {
        haptic.error();
        if (result.locked) toast(t("captcha.locked"), "error");
        else toast(t("captcha.wrong"), "error");
      }
    } catch (e) {
      toast(errText(e), "error");
      if ((e as { code?: string })?.code === "CAPTCHA_LOCKED") setChallenge((c) => ({ ...c, locked: true }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen bottom="none" center class="onboard">
      <ArtWelcome />
      <LargeTitle align="center" size="title" title={t("captcha.title")} sub={t("captcha.sub")} />
      {loading || !challenge ? (
        <div class="card pad"><Skeleton h={44} /><Skeleton h={48} /><Skeleton h={48} /></div>
      ) : challenge.locked ? (
        <Notice tone="error">{t("captcha.locked")}{challenge.retryAt ? ` (${new Date(challenge.retryAt * 1000).toLocaleTimeString()})` : ""}</Notice>
      ) : challenge.verified ? (
        <Notice tone="info">{t("captcha.passed")}</Notice>
      ) : (
        <>
          <div class="card pad" style="text-align:center">
            <p class="note">{t("captcha.tries", { n: challenge.attemptsLeft ?? 5 })}</p>
            <h2 class="num-xl" dir="ltr">{challenge.a} + {challenge.b} = ?</h2>
          </div>
          <List role="group" label={t("captcha.prompt")}>
            {(challenge.choices ?? []).map((n) => (
              <Row key={n} center title={<span class="num-m">{n}</span>} onClick={() => void choose(n)} disabled={busy} />
            ))}
          </List>
        </>
      )}
    </Screen>
  );
}
