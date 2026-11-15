// #/handover — Kontowechsel: the account-switch page. Reads /api/handover,
// polls it every 15s while open (same pattern as Quota.tsx), and lets the
// user restart waiting/failed/unclear handovers as fresh terminal sessions
// (see lib/handover.ts for the API contract).
import { useCallback, useEffect, useState } from "react";
import { HandoverPanel } from "../components/HandoverPanel";
import { fetchHandover, handoverErrorText, startHandovers, startStatusText, type HandoverOverview } from "../lib/handover";

const POLL_MS = 15000;

export default function Handover() {
  const [overview, setOverview] = useState<HandoverOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [account, setAccount] = useState<"login" | "auto">("login");
  const [skip, setSkip] = useState(true);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("");

  const load = useCallback(() => {
    fetchHandover()
      .then((data) => {
        setOverview(data);
        setError(null);
      })
      .catch((e: unknown) => setError(handoverErrorText(e)));
  }, []);

  useEffect(() => {
    load();
    const t = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  async function start(switchId: string | undefined, ids?: string[], again = false) {
    if (!switchId) return;
    setBusy(true);
    setStatusText("");
    try {
      const r = await startHandovers({ switchId, ...(ids ? { ids } : {}), account, skip, again });
      setStatusText(startStatusText(r));
      load();
    } catch (err) {
      setStatusText(handoverErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="page error-box">{error}</div>;
  if (!overview) return <div className="page">Lädt …</div>;

  return (
    <div className="page">
      <HandoverPanel
        overview={overview}
        account={account}
        onAccountChange={setAccount}
        skip={skip}
        onSkipChange={setSkip}
        onStartAll={() => void start(overview.current?.switchId)}
        onStartOne={(switchId, id, again) => void start(switchId, [id], again)}
        busy={busy}
        statusText={statusText}
      />
    </div>
  );
}
