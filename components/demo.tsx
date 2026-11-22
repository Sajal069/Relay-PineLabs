"use client";

import { FlaskConical, Radio, RotateCcw, TimerOff, WifiOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { checkDetails, type Application } from "@/lib/model";
import { Dialog } from "./dialog";
import { InlineError, Spinner } from "./ui";
import type { QueueData } from "./queue";

export function DemoControls({ app, queue, close, action, busy, error, message }: {
  app?: Application; queue?: QueueData; close: () => void;
  action: (payload: Record<string, unknown>) => Promise<void>; busy: boolean; error: string; message: string;
}) {
  const router = useRouter();
  const [appId, setAppId] = useState(queue?.rows[0]?.id ?? "");
  const [past, setPast] = useState(false);
  return <Dialog title="Demo controls" close={close} drawer>
    <div className="drawer-body">
      <div className="demo-intro"><FlaskConical size={18}/><p>Sandbox controls for simulated provider callbacks and merchant ID setup.</p></div>
      {error && <InlineError message={error}/>}
      {message && <div className="demo-notice" role="status">{message}</div>}
      {app?.state === "closed_duplicate" ? <div className="drawer-section"><h3>Application closed</h3></div> : app ? <>
        <div className="drawer-section">
          <div className="drawer-section-heading"><div><h3>Verification callbacks</h3><p>{app.name} · {app.id}</p></div>{busy && <Spinner/>}</div>
          <button className="button primary full-width" disabled={busy || !app.checks.some(check => check.status === "pending" && check.delivery === "held")}
            onClick={() => void action({ action: "deliverAll" })}><Radio size={16}/>Deliver pending callbacks</button>
          <label className="toggle-line"><input type="checkbox" checked={past} onChange={event => setPast(event.target.checked)}/>Show superseded attempts</label>
          <div className="demo-check-list">
            {(past ? app.attempts : app.checks).map(item => <div key={item.id} className="demo-check">
              <div><strong>{checkDetails[item.kind].label}</strong>
                <span>{item.current ? "Current attempt" : "Superseded attempt"} · {item.delivery === "received" ? "Callback received" : item.delivery === "dead" ? "Dead letter" : item.delivery === "scheduled" ? "Scheduled" : item.status === "timed_out" ? "Timed out" : "Callback held"}</span></div>
              <div className="demo-check-actions">
                {item.delivery === "received"
                  ? <button className="button secondary small" disabled={busy} onClick={() => void action({ action: "replay", attempt: item.id })}><RotateCcw size={14}/>Replay</button>
                  : item.delivery === "held" && <button className="button secondary small" disabled={busy} onClick={() => void action({ action: "deliver", attempt: item.id })}>Deliver</button>}
                {item.current && item.status === "pending" && item.delivery === "held" && <>
                  <button className="icon-button timeout-button" title={`Simulate ${item.kind.toUpperCase()} timeout`}
                    aria-label={`Simulate ${item.kind.toUpperCase()} timeout`} disabled={busy}
                    onClick={() => void action({ action: "timeout", attempt: item.id })}><TimerOff size={17}/></button>
                  <button className="icon-button timeout-button" title={`Simulate ${item.kind.toUpperCase()} callback outage`}
                    aria-label={`Simulate ${item.kind.toUpperCase()} callback outage`} disabled={busy}
                    onClick={() => void action({ action: "failDelivery", attempt: item.id })}><WifiOff size={17}/></button>
                </>}
              </div>
            </div>)}
          </div>
        </div>
        <div className="drawer-section">
          <h3>Merchant ID setup</h3><p>Trigger a provisioning failure, or replay a completed setup callback.</p>
          <label className="toggle-line"><input type="checkbox" checked={app.fail_next} disabled={busy || app.setup === "active" || app.setup === "pending"}
            onChange={() => void action({ action: "failNext" })}/>Fail next provisioning attempt</label>
          {app.setup === "active" && <button className="button secondary full-width" disabled={busy}
            onClick={() => void action({ action: "replaySetup" })}><RotateCcw size={15}/>Replay setup success callback</button>}
        </div>
      </> : <div className="drawer-section">
        <h3>Choose an application</h3><p>Open a case to control its verification or setup.</p>
        <form className="demo-select" onSubmit={event => {
          event.preventDefault();
          close();
          router.push(`/applications/${appId}?demo=1`);
        }}>
          <select value={appId} onChange={event => setAppId(event.target.value)} aria-label="Application">
            <option value="" disabled>Select an application</option>
            {queue?.rows.map(row => <option key={row.id} value={row.id}>{row.name} · {row.id}</option>)}
          </select>
          <button className="button primary" disabled={!appId}>Open application controls</button>
        </form>
      </div>}
    </div>
  </Dialog>;
}
