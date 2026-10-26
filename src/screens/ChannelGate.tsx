import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { Me } from "../../shared/types";
import { api } from "../api";
import { meStore } from "../store";
import { ArtWelcome } from "../art";
import { t } from "../i18n";
import { haptic, openTelegramLink } from "../tg";
import { BottomButtons, List, Notice, Row, Screen, Skeleton, errText, toast } from "../ui";
import "./ChannelGate.css";

type Community = { id: string; title: string; joined: boolean; unavailable: boolean };
type Verify = { result: "member" | "not_member" | "unavailable"; me: Me };

/** Multi-community join screen. Each join action requests a user-specific, single-use invite from the Worker. */
export function ChannelGate() {
  const [items, setItems] = useState<Community[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [notJoined, setNotJoined] = useState(false);
  const busyRef = useRef(false);
  const verifyRef = useRef(false);

  const loadStatus = useCallback(async () => {
    try {
      const r = await api<{ communities: Community[] }>("/communities/status");
      setItems(r.communities);
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadStatus();
    const onFocus = () => void loadStatus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [loadStatus]);

  const join = async (index: number) => {
    if (busyRef.current || items[index]?.joined) return;
    busyRef.current = true;
    setBusyIndex(index);
    haptic.tap();
    try {
      const r = await api<{ url: string | null; joined?: boolean; private?: boolean }>(`/communities/${index}/invite`, { body: {} });
      if (r.joined) {
        await loadStatus();
        return;
      }
      if (!r.url) {
        toast(t("gate.inviteUnavailable"), "error");
        return;
      }
      openTelegramLink(r.url);
    } catch (e) {
      toast(e instanceof Error && (e as { code?: string }).code === "INVITE_UNAVAILABLE" ? t("gate.inviteUnavailable") : errText(e), "error");
    } finally {
      busyRef.current = false;
      setBusyIndex(null);
    }
  };

  const verify = async () => {
    if (verifyRef.current) return;
    verifyRef.current = true;
    setVerifying(true);
    try {
      const r = await api<Verify>("/channel/verify", { method: "POST", body: {} });
      if (r.result !== "member") {
        haptic.error();
        setNotJoined(true);
        if (r.result === "unavailable") toast(t("gate.checkUnavailable"), "error");
        await loadStatus();
        return;
      }
      haptic.success();
      toast(t("gate.joined"), "ok");
      meStore.set(r.me);
    } catch (e) {
      toast(errText(e), "error");
    } finally {
      verifyRef.current = false;
      setVerifying(false);
    }
  };

  const allJoined = items.length > 0 && items.every((x) => x.joined);
  return (
    <Screen bottom="native" center class="onboard" overlay={<BottomButtons main={{ text: verifying ? t("gate.checking") : t("gate.verify"), onClick: verify, progress: verifying, disabled: loading || !items.length }} secondary={null} />}>
      <ArtWelcome />
      <h1 class="gate-title rise" style="--d:140ms">{t("gate.title")}</h1>
      <p class="gate-body rise" style="--d:180ms">{t("gate.multiBody")}</p>
      {loading ? <div class="card pad"><Skeleton h={54} /><Skeleton h={54} /><Skeleton h={54} /></div> : items.length ? (
        <List>
          {items.map((item, index) => (
            <Row
              key={item.id}
              icon={item.joined ? "check" : "users"}
              plate={item.joined ? "var(--lime)" : "var(--sky)"}
              wrap
              title={item.title}
              meta={item.joined ? t("gate.joinedStatus") : item.unavailable ? t("gate.statusUnavailable") : t("gate.tapJoin")}
              value={item.joined ? <span class="ok-text">{t("gate.joinedStatus")}</span> : <span class="join-pill">{busyIndex === index ? t("common.loading") : t("gate.join")}</span>}
              onClick={item.joined || item.unavailable || busyIndex !== null ? undefined : () => void join(index)}
              disabled={item.joined || item.unavailable || busyIndex !== null}
            />
          ))}
        </List>
      ) : <Notice tone="warn">{t("gate.noCommunities")}</Notice>}
      {notJoined ? <div class="gate-note"><Notice tone="warn">{t("gate.notJoined")}</Notice></div> : null}
      {allJoined ? <Notice tone="info">{t("gate.readyVerify")}</Notice> : null}
    </Screen>
  );
}
