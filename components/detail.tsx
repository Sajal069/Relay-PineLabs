"use client";

import { useState } from "react";
import Link from "next/link";
import {
  AlertTriangle, ArrowUpRight, Building2, Check as CheckIcon, CircleCheck, ClipboardList, Clock3, FileText,
  Fingerprint, GitPullRequest, Landmark, RefreshCw, ShieldCheck,
} from "lucide-react";
import { checkDetails, checkLabels, intakeLabels, type Application, type CheckKind, type Evidence, type IntakeItem } from "@/lib/model";
import { BackLink, InlineError, MerchantMark, Spinner, Status, timestamp } from "./ui";
import { Dialog } from "./dialog";

const checkIcons = { pan: Fingerprint, gst: FileText, bank: Landmark };

function Highlight({ value, baseline }: { value: string; baseline: string }) {
  const words = value.split(" ");
  const compare = baseline.toLowerCase().split(" ");
  let first = 0;
  let last = words.length;
  while (first < Math.min(words.length, compare.length) && words[first].toLowerCase() === compare[first]) first++;
  while (last > first && words.length - last < compare.length - first &&
    words[last - 1].toLowerCase() === compare[compare.length - 1 - (words.length - last)]) last--;
  if (first === last) return <>{value}</>;
  return <>{words.slice(0, first).join(" ")}{first > 0 && " "}
    <mark>{words.slice(first, last).join(" ")}</mark>
    {last < words.length && ` ${words.slice(last).join(" ")}`}</>;
}

function EvidenceGrid({ evidence, kind }: { evidence: Evidence; kind: CheckKind }) {
  const mismatch = kind === "gst" && evidence.provider &&
    evidence.submitted.toLowerCase() !== evidence.provider.toLowerCase();
  const documentDiffers = kind === "gst" && evidence.submitted.toLowerCase() !== evidence.extracted.toLowerCase();
  return <div className="evidence-grid">
    <div className="evidence-card">
      <span className="evidence-label"><ClipboardList size={15}/> Submitted value</span>
      <p>{mismatch ? <Highlight value={evidence.submitted} baseline={evidence.provider!}/> : evidence.submitted}</p>
      <span className="evidence-meta">Merchant application</span>
    </div>
    <div className="evidence-card">
      <span className="evidence-label"><FileText size={15}/> Extracted value</span>
      <p>{documentDiffers ? <Highlight value={evidence.extracted} baseline={evidence.submitted}/> : evidence.extracted}</p>
      <span className={`evidence-meta ${evidence.confidence !== null && evidence.confidence < 70 ? "low-confidence" : ""}`}>
        {evidence.extraction ? `AI extraction · ${evidence.extraction.model}` : `${evidence.confidence}% confidence · Simulated extraction`}
      </span>
    </div>
    <div className="evidence-card">
      <span className="evidence-label"><ShieldCheck size={15}/> Provider response</span>
      <p>{mismatch ? <Highlight value={evidence.provider!} baseline={evidence.submitted}/> : evidence.provider ?? "Awaiting callback"}</p>
      <span className="evidence-meta">{checkDetails[kind].provider}</span>
    </div>
  </div>;
}

export type OperatorAction = (payload: Record<string, unknown>) => Promise<boolean>;

export function Detail({ application: app, operate, busy, error }: {
  application: Application; operate: OperatorAction; busy: boolean; error: string;
}) {
  const [selected, setSelected] = useState<CheckKind | null | undefined>();
  const [correction, setCorrection] = useState<CheckKind | null>(null);
  const [missingRequest, setMissingRequest] = useState<IntakeItem[] | null>(null);
  const [duplicateAction, setDuplicateAction] = useState<{ id: string; close: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const failure = app.checks.find(item => item.status === "failed" && app.requiredChecks.includes(item.kind));
  const timeout = app.checks.find(item => item.status === "timed_out");
  const extractionIssue = app.evidenceIssues.find(issue => issue.blocking);
  const chosen = selected === undefined ? failure?.kind ?? extractionIssue?.kind ?? timeout?.kind : selected;
  const selection = app.checks.find(item => item.kind === chosen);
  const reviewTarget = selection?.status === "failed" || app.evidenceIssues.some(issue => issue.blocking && issue.kind === chosen)
    ? chosen : failure?.kind ?? extractionIssue?.kind;
  const retryTarget = selection?.status === "timed_out" ? selection : timeout;
  const isRetry = Boolean(retryTarget && (!reviewTarget || selection?.status === "timed_out"));
  const passed = app.checks.filter(item => item.status === "passed" && app.requiredChecks.includes(item.kind)).length;
  const canRetry = app.state !== "closed_duplicate" && app.state !== "correction";
  const duplicateReview = app.state !== "approved" && app.state !== "closed_duplicate";
  const root = `/applications/${app.id}`;
  const historyIcon = (title: string) => title.includes("failed") || title.includes("timed out") ? AlertTriangle
    : title.includes("created") || title.includes("approved") ? CircleCheck
    : title.includes("changed") || title.includes("requested") ? GitPullRequest : Clock3;

  function review() {
    if (isRetry && retryTarget) {
      void operate({ action: "retryCheck", kind: retryTarget.kind });
    } else if (reviewTarget) {
      setCorrection(reviewTarget);
      setReason("");
    }
  }

  return <>
    <BackLink />
    <div className="detail-heading">
      <MerchantMark name={app.name} large />
      <div className="merchant-heading">
        <h1>{app.name}</h1>
        <div className="detail-subline"><span className="mono">{app.id}</span>
          <span>{[app.sector, app.city].filter(Boolean).join(" · ")}</span><Status row={app}/></div>
      </div>
      <div className="heading-actions">
        {app.state === "incomplete" && <button className="button primary" disabled={busy}
          onClick={() => { setReason(""); setMissingRequest(app.missing); }}>Request missing information</button>}
        {app.state === "review" && (reviewTarget || retryTarget) && <button className="button primary" onClick={review} disabled={busy}>
          {busy ? <Spinner/> : isRetry ? <RefreshCw size={16}/> : null}{isRetry ? "Retry verification" : "Request correction"}
        </button>}
        {app.state === "ready" && <button className="button primary" disabled={busy} onClick={() => void operate({ action: "approve" })}>
          {busy ? <Spinner/> : <CheckIcon size={17}/>}Approve application
        </button>}
        {app.state === "approved" && app.setup === "failed" &&
          <button className="button primary" disabled={busy} onClick={() => void operate({ action: "retrySetup" })}>
            {busy ? <Spinner/> : <RefreshCw size={16}/>}Retry setup
          </button>}
        {app.state === "approved" && app.setup === "pending" && <span className="muted-action"><Spinner/>Creating merchant ID</span>}
      </div>
    </div>
    {error && !correction && !missingRequest && !duplicateAction && <InlineError message={error}/>}
    <div className="review-layout">
      <div className="review-main">
        {app.missing.length > 0 && app.state !== "closed_duplicate" && <section className="panel">
          <div className="panel-heading"><div><h2>Missing information</h2><p>{app.missing.length} required items still needed</p></div></div>
          <div className="form-body"><ul className="issue-list">{app.missing.map(item => <li key={item}>{intakeLabels[item]}</li>)}</ul></div>
        </section>}
        {app.duplicates.length > 0 && app.state !== "closed_duplicate" && <section className="panel">
          <div className="panel-heading"><div><h2>Matching applications</h2><p>Review each match before approving this application.</p></div></div>
          <div className="form-body match-list">{app.duplicates.map(match => <div key={match.applicationId} className="match-row">
            <div><Link href={`/applications/${match.applicationId}`}><strong>{match.name}</strong> <span className="mono">{match.applicationId}</span></Link>
              <p>{match.reasons.join(" · ")}</p></div>
            {match.cleared ? <span className="status green">Cleared</span> : duplicateReview && <div className="match-actions">
              <button className="button secondary small" disabled={busy} onClick={() => {
                setReason(""); setDuplicateAction({ id: match.applicationId, close: false });
              }}>Clear match</button>
              <button className="button secondary small" disabled={busy} onClick={() => {
                setReason(""); setDuplicateAction({ id: match.applicationId, close: true });
              }}>Close as duplicate</button>
            </div>}
          </div>)}</div>
        </section>}
        <section className="panel" aria-labelledby="verification-title">
          <div className="panel-heading">
            <div><h2 id="verification-title">Verification checks</h2><p>All mandatory checks must pass before approval.</p></div>
            <span className="check-count"><ShieldCheck size={15}/>{passed} of {app.requiredChecks.length} required verified</span>
          </div>

          {app.state === "review" && <div className="review-banner" role="status">
            <AlertTriangle size={19}/><div><strong>Approval blocked</strong>
              <p>{app.blocker}.</p>
            </div></div>}
          {app.correction && <div className="review-banner"><Clock3 size={19}/><div><strong>Awaiting correction</strong>
            <p>{app.correction.reason}</p></div></div>}
          {app.evidenceIssues.map(issue => <div className="review-banner" key={issue.kind}>
            <AlertTriangle size={19}/><div><strong>{checkDetails[issue.kind].label} · {issue.blocking ? "Evidence needs review" : "Optional evidence warning"}</strong>
              <p>{issue.reason}.</p></div>
          </div>)}
          {app.state === "approved" && app.setup === "failed" && <div className="review-banner danger-banner">
            <AlertTriangle size={19}/><div><strong>Approved · Setup failed</strong><p>Retry provisioning to create the merchant ID.</p></div></div>}
          {app.merchant_id && <div className="review-banner success-banner"><CircleCheck size={19}/><div><strong>Merchant ID active</strong>
            <p className="mono">{app.merchant_id}</p></div></div>}

          <div className="checks">
            {app.checks.map(item => {
              const Icon = checkIcons[item.kind];
              const open = chosen === item.kind;
              return <div className={`check-item ${open ? "open" : ""}`} key={item.kind}>
                <button className="check-trigger" aria-expanded={open} aria-controls={`evidence-${item.kind}`}
                  onClick={() => setSelected(open ? null : item.kind)}>
                  <span className="check-icon"><Icon size={19}/></span>
                  <span className="check-name"><strong>{checkDetails[item.kind].label}</strong><span>{checkDetails[item.kind].provider}
                    {!app.requiredChecks.includes(item.kind) && " · Optional"}</span></span>
                  <span className={`status ${{pending: "blue", passed: "green", failed: "danger", timed_out: "amber"}[item.status]}`}>
                    <span className="status-dot"/>{checkLabels[item.status]}
                  </span>
                  <span className="check-timestamp">{timestamp(item.updated_at)}</span>
                  <span className="check-chevron" aria-hidden="true">⌄</span>
                </button>
                {open && <div className="check-evidence" id={`evidence-${item.kind}`}>
                  <EvidenceGrid evidence={item.evidence} kind={item.kind}/>
                  <p className="evidence-note">{item.evidence.reason}.</p>
                  {item.delivery === "dead" && <p className="field-warning">Callback delivery exhausted its retries.</p>}
                  {item.status === "timed_out" && canRetry && !(app.state === "review" && isRetry && retryTarget?.id === item.id) &&
                    <button className="button secondary small" disabled={busy} onClick={() => void operate({ action: "retryCheck", kind: item.kind })}>Retry verification</button>}
                </div>}
              </div>;
            })}
          </div>
        </section>
        <section className="panel submission-link-panel">
          <span className="check-icon"><Building2 size={19}/></span>
          <div><h2>Merchant submission</h2><p>See the details and supporting documents provided by the merchant.</p></div>
          <Link className="button secondary small" href={`${root}/submission`}>View submission <ArrowUpRight size={15}/></Link>
        </section>
      </div>
      <aside className="panel activity-panel">
        <div className="panel-heading"><div><h2>Activity trail</h2><p>Latest activity first</p></div><Clock3 size={18} className="activity-heading-icon"/></div>
        <ol className="timeline">
          {app.activity.map(event => {
            const Icon = historyIcon(event.title);
            return <li key={event.id}><span className="timeline-icon"><Icon size={14}/></span>
              <div><strong>{event.title}</strong><p>{event.description}</p><span>{event.actor} · {timestamp(event.at)}</span></div>
            </li>;
          })}
        </ol>
      </aside>
    </div>
    {correction && <Dialog title="Request correction" close={() => setCorrection(null)}>
      <form className="dialog-form" onSubmit={async event => {
        event.preventDefault();
        if (await operate({ action: "requestCorrection", kind: correction, reason })) setCorrection(null);
      }}>
        <p>Ask {app.name} to update their {checkDetails[correction].field.toLowerCase()} or supporting evidence.</p>
        {error && <InlineError message={error}/>}
        <label className="field"><span>Reason for correction</span>
          <textarea required autoFocus maxLength={500} value={reason} onChange={event => setReason(event.target.value)} rows={4}
            placeholder={correction === "gst" ? "Please enter the legal name shown on your GST certificate." : "Describe the evidence the merchant needs to update."}/>
        </label>
        <div className="dialog-actions"><button className="button secondary" type="button" onClick={() => setCorrection(null)}>Cancel</button>
          <button className="button primary" type="submit" disabled={busy || !reason.trim()}>{busy && <Spinner/>}Send correction request</button></div>
      </form>
    </Dialog>}
    {missingRequest && <Dialog title="Request missing information" close={() => setMissingRequest(null)}>
      <form className="dialog-form" onSubmit={async event => {
        event.preventDefault();
        if (await operate({ action: "requestMissing", items: missingRequest, reason })) setMissingRequest(null);
      }}>
        <fieldset className="request-items">
          <legend>Information to request</legend>
          {app.missing.map(item => <label className="toggle-line" key={item}><input type="checkbox"
            checked={missingRequest.includes(item)} onChange={event => setMissingRequest(event.target.checked
              ? [...missingRequest, item] : missingRequest.filter(key => key !== item))}/>{intakeLabels[item]}</label>)}
        </fieldset>
        <label className="field"><span>Reason for request</span>
          <textarea required maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)}/>
        </label>
        {error && <InlineError message={error}/>}
        <div className="dialog-actions"><button className="button secondary" type="button" onClick={() => setMissingRequest(null)}>Cancel</button>
          <button className="button primary" disabled={busy || !reason.trim() || !missingRequest.length}>Send inbox request</button></div>
      </form>
    </Dialog>}
    {duplicateAction && <Dialog title={duplicateAction.close ? "Close as duplicate" : "Clear duplicate match"} close={() => setDuplicateAction(null)}>
      <form className="dialog-form" onSubmit={async event => {
        event.preventDefault();
        if (await operate({ action: duplicateAction.close ? "closeDuplicate" : "clearDuplicate", matchedId: duplicateAction.id, reason })) {
          setDuplicateAction(null);
        }
      }}>
        <p>{duplicateAction.close ? "Close this application permanently. The merchant will see that it was closed as a duplicate."
          : "Record why this application can continue despite the match."}</p>
        <label className="field"><span>Decision reason</span>
          <textarea required autoFocus maxLength={500} rows={3} value={reason} onChange={event => setReason(event.target.value)}/>
        </label>
        {error && <InlineError message={error}/>}
        <div className="dialog-actions"><button className="button secondary" type="button" onClick={() => setDuplicateAction(null)}>Cancel</button>
          <button className="button primary" disabled={busy || !reason.trim()}>{duplicateAction.close ? "Close application" : "Clear match"}</button></div>
      </form>
    </Dialog>}
  </>;
}
