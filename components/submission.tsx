"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowUpRight, Building2, Check, ChevronRight, CircleCheck, Eye, EyeOff, FileCheck2, FileText, FlaskConical, Landmark, Sparkles, UserRound } from "lucide-react";
import { checkDetails, checkKinds, checkLabels, emptyForm, intakeLabels, sampleForm, type Application, type CheckKind, type DocumentInput, type FormInput, type IntakeItem } from "@/lib/model";
import { extractionGuides, extractionProviderLabel, type ExtractedDocument } from "@/lib/onboarding";
import { AgentIntake, DocumentPicker, useExtractionStatus } from "./onboarding-agent";
import { readDocument } from "./document-files";
import { BackLink, InlineError, Spinner, Status } from "./ui";

export class RelayRequestError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}

export async function requestJson<T>(url: string, payload?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, payload === undefined ? { signal, cache: "no-store" } : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new RelayRequestError(body?.error ?? "The workspace could not be reached. Try again.", response.status);
  }
  return response.json();
}

function Section({ icon: Icon, title, children }: {
  icon: typeof Building2; title: string; children: React.ReactNode;
}) {
  return <section className="panel form-panel"><div className="panel-heading"><span className="check-icon"><Icon size={19}/></span><h2>{title}</h2></div>
    <div className="form-body">{children}</div></section>;
}

function Field({ label, value, update, placeholder, secret, required = true }: {
  label: string; value: string; update: (text: string) => void; placeholder?: string; secret?: boolean; required?: boolean;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  const input = <input id={id} type={secret && !visible ? "password" : "text"} required={required}
    value={value} onChange={event => update(event.target.value)} maxLength={secret ? 18 : 120}
    placeholder={placeholder} autoComplete="off" autoCapitalize={secret ? "off" : undefined}
    spellCheck={secret ? false : undefined}/>;

  return <div className="field">
    <label htmlFor={id}>{label}</label>
    {secret ? <div className="reveal-input">
      {input}
      <button type="button" className="icon-button" aria-controls={id}
        aria-label={`${visible ? "Hide" : "Show"} ${label}`} onClick={() => setVisible(previous => !previous)}>
        {visible ? <EyeOff size={17}/> : <Eye size={17}/>}
      </button>
    </div> : input}
  </div>;
}

const docLabels = { pan: "PAN shown on document", gst: "Legal name on GST certificate", bank: "Account shown on bank proof" };
const docNames = { pan: "PAN document", gst: "GST certificate", bank: "Bank proof" };

function DocumentFields({ kind, value, update, optional = false, placeholder }: {
  kind: CheckKind; value: DocumentInput; update: (value: DocumentInput) => void; optional?: boolean; placeholder?: string;
}) {
  return <div className="document-fields">
    <Field label={docLabels[kind]} secret={kind !== "gst"} value={value.value} required={!optional}
      update={text => update({ ...value, value: text, receipt: undefined })} placeholder={placeholder}/>
    <label className="field quality-field"><span>Document quality</span>
      <select value={value.quality} onChange={event => update({ ...value, quality: event.target.value as DocumentInput["quality"], receipt: undefined })}>
        <option value="clear">Clear</option><option value="blurred">Blurred</option>
      </select>
    </label>
    {value.receipt && <p className="document-source"><Sparkles size={13}/>Extracted by the onboarding agent</p>}
  </div>;
}

const categories = [
  "Apparel & textiles", "Beauty & wellness", "Design services", "Education", "Food & beverage",
  "Home & living", "Outdoor retail", "Sports & recreation", "Stationery & retail", "Travel & tourism", "Other",
];

export function NewApplication({ onCreated, requiredChecks }: { onCreated: (id: string) => void; requiredChecks: CheckKind[] }) {
  const [phase, setPhase] = useState<"documents" | "review">("documents");
  const [reading, setReading] = useState(false);
  const [form, setForm] = useState<FormInput>(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sample, setSample] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [agentVersion, setAgentVersion] = useState(0);
  const status = useExtractionStatus();
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const extractedCount = checkKinds.filter(kind => form.documents[kind].receipt).length;
  const gstRequired = requiredChecks.includes("gst");
  const fields: { key: Exclude<keyof FormInput, "documents">; label: string; secret?: boolean; placeholder?: string }[] = [
    { key: "name", label: "Merchant display name", placeholder: "Enter trading name" },
    { key: "legalName", label: "Registered legal name", placeholder: "Enter legal business name" },
    { key: "city", label: "City", placeholder: "e.g. Pune" },
    { key: "gstin", label: "GSTIN", secret: true, placeholder: "Enter fictional GSTIN" },
    { key: "signatory", label: "Full name", placeholder: "Enter signatory name" },
    { key: "pan", label: "PAN", secret: true, placeholder: "Enter fictional PAN" },
    { key: "account", label: "Account number", secret: true, placeholder: "Enter fictional account number" },
    { key: "ifsc", label: "IFSC", secret: true, placeholder: "Enter fictional IFSC" },
  ];
  const renderField = (field: typeof fields[number]) => <Field key={field.key} label={field.label} secret={field.secret}
    value={form[field.key]} placeholder={field.placeholder} required={field.key !== "gstin" || gstRequired}
    update={text => setForm(current => ({ ...current, [field.key]: text }))}/>;

  useEffect(() => {
    if (phase === "review") reviewHeading.current?.focus();
  }, [phase]);

  function updateFromDocument(kind: CheckKind, result?: ExtractedDocument, previous?: ExtractedDocument) {
    const guide = extractionGuides[kind];
    setConfirmed(false);
    setForm(current => {
      const next = { ...current, documents: { ...current.documents } };
      for (const field of guide.fields) {
        if (previous?.values[field] && current[field] === previous.values[field]) next[field] = "";
        const extracted = result?.values[field];
        if (extracted && !next[field]) next[field] = extracted;
      }
      const value = result?.values[guide.primary];
      if (value) {
        next.documents[kind] = { value, quality: "clear", receipt: result?.receipt, assessmentReceipt: result?.assessmentReceipt };
      } else {
        const prior = current.documents[kind];
        const replaceValue = previous?.receipt && previous.receipt === prior.receipt;
        next.documents[kind] = {
          ...(replaceValue ? emptyForm.documents[kind] : prior),
          assessmentReceipt: result?.assessmentReceipt,
        };
      }
      return next;
    });
  }

  async function submit(shareIncomplete: boolean) {
    if (extractedCount > 0 && !confirmed) {
      setError("Confirm the extracted details before sharing the application.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await requestJson<{ id: string }>("/api/relay", { ...form, shareIncomplete });
      onCreated(result.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Submission failed. Try again.");
      setBusy(false);
    }
  }

  return <>
    <BackLink />
    <div className="page-heading form-heading">
      <div><h1>New application</h1><p>Prepare a merchant application for verification.</p></div>
      <button className="button secondary" type="button" disabled={busy || reading} onClick={() => {
        setForm(sampleForm);
        setError("");
        setConfirmed(false);
        setSample(true);
        setAgentVersion(version => version + 1);
        setPhase("review");
      }}>
        <FlaskConical size={17}/>Use sample application
      </button>
    </div>
    <nav className="intake-steps" aria-label="Application progress">
      <button type="button" disabled={busy} className={phase === "documents" ? "intake-step current" : "intake-step"}
        aria-current={phase === "documents" ? "step" : undefined} onClick={() => setPhase("documents")}><FileText size={16}/>Documents</button>
      <ChevronRight size={15} aria-hidden="true"/>
      <button type="button" disabled={reading || busy} className={phase === "review" ? "intake-step current" : "intake-step"}
        aria-current={phase === "review" ? "step" : undefined} onClick={() => setPhase("review")}><FileCheck2 size={16}/>Review &amp; submit</button>
    </nav>
    <div hidden={phase !== "documents"}>
      <AgentIntake key={agentVersion} status={status} onReading={setReading} onResult={updateFromDocument}
        onSample={() => {
          setSample(false);
          setForm(current => ({ ...current, name: current.name || sampleForm.name, sector: current.sector || sampleForm.sector }));
        }}
        onReview={() => { setError(""); setPhase("review"); }}/>
    </div>
    {phase === "review" && <form className="form-layout" onSubmit={event => { event.preventDefault(); void submit(false); }}>
      <div className="form-stack">
        <div className="review-intake-head">
          <h2 ref={reviewHeading} tabIndex={-1}>Review application details</h2>
          <p>{extractedCount ? "Confirm the suggested values and fill in anything the agent couldn’t read." : "Enter the merchant details and supporting evidence."}</p>
        </div>
        <Section icon={Building2} title="Business details">
          <div className="fields-grid">{fields.slice(0, 4).map(renderField)}
            <label className="field"><span>Business category</span><select required value={form.sector}
              onChange={event => setForm(current => ({ ...current, sector: event.target.value }))}>
              <option value="" disabled>Choose a category</option>{categories.map(value => <option key={value}>{value}</option>)}
            </select></label>
          </div>
        </Section>
        <Section icon={UserRound} title="Authorised signatory"><div className="fields-grid">{fields.slice(4, 6).map(renderField)}</div></Section>
        <Section icon={Landmark} title="Bank information"><div className="fields-grid">{fields.slice(6).map(renderField)}</div></Section>
        <Section icon={FileText} title="Supporting documents">
          <p className="form-description">Confirm the values actually shown on each document.</p>
          <div className="document-stack">{checkKinds.map(kind => {
            const entry = form.documents[kind];
            const entered = form[extractionGuides[kind].primary];
            return <div className="review-document" key={kind}>
              <DocumentFields kind={kind} value={entry} optional={kind === "gst" && !gstRequired}
                update={value => setForm(current => ({ ...current, documents: { ...current.documents, [kind]: value } }))}/>
              {!entry.value && entered && <button type="button" className="button secondary small" onClick={() => setForm(current => ({
                ...current, documents: { ...current.documents, [kind]: { ...entry, value: entered, quality: "clear" } },
              }))}>Use value from application</button>}
            </div>;
          })}</div>
        </Section>
        {extractedCount > 0 && <label className="agent-confirm"><input type="checkbox" required checked={confirmed}
          onChange={event => setConfirmed(event.target.checked)}/>
          <span>I reviewed the extracted details and confirm they match the supporting documents.</span></label>}
        {error && <InlineError message={error}/>}
        <div className="form-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setPhase("documents")}>Back to documents</button>
          <button type="button" className="button secondary" disabled={busy || !form.name.trim()} onClick={() => void submit(true)}>Send for review</button>
          <button type="submit" className="button primary" disabled={busy}>{busy && <Spinner/>}Submit application</button></div>
      </div>
      <aside className="panel form-aside">
        <span className="check-icon"><Sparkles size={19}/></span><h2>Onboarding checklist</h2>
        <p>{extractedCount > 0 ? `${extractedCount} of 3 supporting documents contain AI-extracted evidence.` : "Add the values from your supporting documents."}</p>
        <p className="checklist-note">{gstRequired ? "PAN, GST and bank verification are required." : "PAN and bank verification are required. GST is optional."} Use Send for review to share the information you have with the owner.</p>
        {sample && <p className="sample-filled" role="status"><CircleCheck size={17}/>Sample application loaded</p>}
      </aside>
    </form>}
  </>;
}

export function Submission({ app, owner }: { app: Application; owner: boolean }) {
  const root = `/applications/${app.id}`;
  const documentsReceived = checkKinds.filter(kind => app.submission.documents[kind].value).length;
  const needsCorrection = Boolean(app.correction);
  const fields = [
    ["Merchant", app.name], ["Registered legal name", app.submission.legalName],
    ["City", app.city], ["Business category", app.sector], ["GSTIN", app.submission.gstin],
    ["Signatory", app.submission.signatory], ["PAN", app.submission.pan],
    ["Bank account", app.submission.account], ["IFSC", app.submission.ifsc],
  ];

  return <>
    <BackLink href={owner ? root : "/applications"}>{owner ? "Application review" : "My applications"}</BackLink>
    <div className="page-heading form-heading">
      <div><h1>{owner ? "Merchant submission" : app.name}</h1><div className="detail-subline">{owner && <><span>{app.name}</span><span>·</span></>}
        <span className="mono">{app.id}</span><Status row={app}/></div></div>
      {!owner && needsCorrection && <Link className="button primary" href={`${root}/correct`}>
        Open correction form<ArrowUpRight size={16}/>
      </Link>}
    </div>
    <div className="form-layout">
      <div className="form-stack">
        <Section icon={Building2} title="Submitted details">
          <dl className="snapshot-fields">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Not provided"}</dd></div>)}</dl>
          {!owner && ["verifying", "review", "ready"].includes(app.state) && !needsCorrection && <Link className="button secondary small" href={`${root}/correct?check=bank`}>Update bank details</Link>}
        </Section>
        <Section icon={FileCheck2} title="Extraction and validation">
          <p className="form-description">Document evidence and verification results</p>
          <div className="snapshot-checks">{app.checks.map(check =>
            <div key={check.kind}>
              <h3>{docNames[check.kind]}</h3><p>{check.evidence.extracted}</p>
              <span>{check.evidence.extraction ? `AI extraction · ${check.evidence.extraction.model}` : `${check.evidence.confidence}% simulated extraction confidence`} · {checkLabels[check.status]} provider check</span>
              <span className={check.status === "failed" ? "field-warning" : ""}>{check.evidence.reason}</span>
            </div>)}</div>
        </Section>
      </div>
      <aside className="panel form-aside"><span className="check-icon"><Check size={19}/></span>
        <h2>{app.missing.length ? "Missing information" : "Submission complete"}</h2>
        <p>{documentsReceived} of 3 supporting documents received.</p>
        {app.missing.length > 0 && <ul className="issue-list">{app.missing.map(item => <li key={item}>{intakeLabels[item]}</li>)}</ul>}
        {app.evidenceIssues.map(issue => <p className="field-warning" key={issue.kind}>{docNames[issue.kind]} · {issue.reason}</p>)}
        {app.correction && <div className="aside-note"><strong>Correction requested</strong><p>{app.correction.reason}</p></div>}
        {!owner && app.merchant_id && <div className="aside-note"><strong>Merchant ID</strong><p className="mono">{app.merchant_id}</p></div>}
        {!owner && !app.correction && !app.merchant_id && <div className="aside-note"><p>{app.blocker}.</p></div>}
      </aside>
    </div>
  </>;
}

const documentItems: Partial<Record<IntakeItem, CheckKind>> = {
  "documents.pan": "pan", "documents.gst": "gst", "documents.bank": "bank",
};
const maskedItems: IntakeItem[] = ["pan", "gstin", "account", "ifsc"];

export function MissingInformationForm({ app, onSubmit }: {
  app: Application; onSubmit: (input: Record<string, unknown>) => Promise<boolean>;
}) {
  const [values, setValues] = useState<Partial<Record<IntakeItem, string>>>({});
  const [documents, setDocuments] = useState(emptyForm.documents);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState<CheckKind | null>(null);
  const [readError, setReadError] = useState("");
  const job = useRef<AbortController | null>(null);
  const status = useExtractionStatus();
  const root = `/applications/${app.id}`;
  const items = app.correction?.items ?? [];
  useEffect(() => () => job.current?.abort(), []);

  async function read(kind: CheckKind, file: File) {
    if (job.current) return;
    const controller = new AbortController();
    job.current = controller;
    setReading(kind);
    setReadError("");
    try {
      const result = await readDocument(file, kind, controller.signal);
      const value = result.values[extractionGuides[kind].primary];
      setDocuments(current => ({
        ...current,
        [kind]: { ...current[kind], value: value ?? current[kind].value, receipt: result.receipt, assessmentReceipt: result.assessmentReceipt },
      }));
      setValues(current => {
        const next = { ...current };
        for (const field of extractionGuides[kind].fields) {
          if (items.includes(field) && !next[field]) next[field] = result.values[field];
        }
        return next;
      });
      if (!value) setReadError("The agent could not read the requested value. Try another copy or enter it from your document.");
    } catch (error) {
      if (!controller.signal.aborted) setReadError(error instanceof Error ? error.message : "Document reading failed.");
    } finally {
      job.current = null;
      if (!controller.signal.aborted) setReading(null);
    }
  }

  return <>
    <BackLink href={root}>Application</BackLink>
    <div className="page-heading"><h1>Provide missing information</h1><p>{app.name}</p></div>
    <form className="form-layout" onSubmit={async event => {
      event.preventDefault();
      setBusy(true);
      const input = Object.fromEntries(items.map(item => {
        const kind = documentItems[item];
        return [item, kind ? documents[kind] : values[item]];
      }));
      if (!(await onSubmit(input))) setBusy(false);
    }}>
      <div className="form-stack">
        <Section icon={FileText} title="Requested items">
          {items.map(item => {
            const kind = documentItems[item];
            return kind ? <div className="review-document" key={item}>
              {status?.enabled && <DocumentPicker kind={kind} label={`Read ${intakeLabels[item].toLowerCase()}`}
                disabled={!!reading || busy} choose={file => void read(kind, file)}/>}
              <DocumentFields kind={kind} value={documents[kind]} update={document => setDocuments(current => ({ ...current, [kind]: document }))}/>
            </div> : <Field key={item} label={intakeLabels[item]} value={values[item] ?? ""}
              secret={maskedItems.includes(item)} update={value => setValues(current => ({ ...current, [item]: value }))}/>;
          })}
          {reading && <p className="intake-progress" role="status"><Spinner/>Reading document</p>}
          {readError && <InlineError message={readError}/>}
        </Section>
        <div className="form-actions"><Link href={root} className="button secondary">Cancel</Link>
          <button className="button primary" type="submit" disabled={busy || !!reading}>{busy && <Spinner/>}Submit information</button></div>
      </div>
      <aside className="panel form-aside"><span className="check-icon"><FileText size={19}/></span>
        <h2>Reviewer request</h2><p>{app.correction?.reason}</p></aside>
    </form>
  </>;
}

export function Correction({ app, kind, onSubmit }: {
  app: Application; kind: CheckKind; onSubmit: (kind: CheckKind, input: Record<string, unknown>) => Promise<boolean>;
}) {
  const [legalName, setLegalName] = useState(app.submission.legalName);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [document, setDocument] = useState<DocumentInput>(() => ({
    value: kind === "gst" ? app.submission.documents.gst.value : "",
    quality: app.submission.documents[kind].quality,
  }));
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState("");
  const status = useExtractionStatus();
  const readJob = useRef<AbortController>(null);
  const root = `/applications/${app.id}`;
  const updatingBank = !app.correction && kind === "bank" && ["verifying", "review", "ready"].includes(app.state);
  const needsEvidence = app.evidenceIssues.some(issue => issue.kind === kind && issue.blocking);
  const [confirmManual, setConfirmManual] = useState(false);

  useEffect(() => () => readJob.current?.abort(), []);

  if ((!app.correction || app.correction.kind !== kind) && !updatingBank) {
    return <><BackLink href={root}>Application review</BackLink><div className="page-heading"><h1>Correction unavailable</h1></div>
      <InlineError message="This application has no open correction for that field."/>
    </>;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const evidence = { ...document, confirmManual };
    const input = kind === "gst" ? { legalName, gstin: second, document: evidence }
      : kind === "pan" ? { pan: first, document: evidence } : { account: first, ifsc: second, document: evidence };
    if (!(await onSubmit(kind, input))) setBusy(false);
  }

  async function readReplacement(file: File) {
    if (readJob.current) return;
    const job = new AbortController();
    readJob.current = job;
    setReading(true);
    setReadError("");
    try {
      const result = await readDocument(file, kind, job.signal);
      const value = result.values[extractionGuides[kind].primary];
      if (!value) {
        setReadError(result.readability === "wrong_document"
          ? `Upload a replacement ${extractionGuides[kind].title.toLowerCase()}.`
          : "The replacement did not contain a readable value for this check. Try a clearer copy or enter it manually.");
        return;
      }
      setConfirmManual(false);
      setDocument({ value, quality: "clear", receipt: result.receipt, assessmentReceipt: result.assessmentReceipt });
      if (kind === "gst") {
        setLegalName(value);
        if (result.values.gstin) setSecond(result.values.gstin);
      } else {
        setFirst(value);
        if (kind === "bank" && result.values.ifsc) setSecond(result.values.ifsc);
      }
    } catch (error) {
      if (!job.signal.aborted) setReadError(error instanceof Error ? error.message : "The document could not be read.");
    } finally {
      readJob.current = null;
      if (!job.signal.aborted) setReading(false);
    }
  }

  return <>
    <BackLink href={root}>Application review</BackLink>
    <div className="page-heading form-heading"><div><h1>{updatingBank ? "Update bank details" : "Correct merchant information"}</h1>
      <div className="detail-subline"><span>{app.name}</span><span>·</span><span className="mono">{app.id}</span></div></div></div>
    <form className="form-layout" onSubmit={submit}>
      <div className="form-stack">
        <Section title={checkDetails[kind].field} icon={kind === "bank" ? Landmark : FileText}>
          <div className="fields-grid">
            {kind === "gst" && <>
              <Field label="Registered legal name" value={legalName} update={setLegalName}/>
              <Field label="Replacement GSTIN (optional)" secret value={second} update={setSecond}
                placeholder={app.submission.gstin} required={false}/>
            </>}
            {kind === "pan" && <Field label="Replacement PAN (optional)" secret value={first} update={setFirst}
              placeholder={app.submission.pan} required={false}/>}
            {kind === "bank" && <>
              <Field label="Replacement account number (optional)" secret value={first} update={setFirst}
                placeholder={app.submission.account} required={false}/>
              <Field label="Replacement IFSC (optional)" secret value={second} update={setSecond}
                placeholder={app.submission.ifsc} required={false}/>
            </>}
          </div>
          {kind === "gst" && legalName !== document.value && document.value && <button className="button secondary small use-extracted"
            type="button" onClick={() => setLegalName(document.value)}>Use extracted legal name</button>}
          <div className="replacement-evidence">
            <p className="form-description">Supporting evidence</p>
            {status?.enabled && <DocumentPicker kind={kind} disabled={reading || busy}
              label="Read replacement document" choose={file => void readReplacement(file)}/>}
          </div>
          {status?.enabled && status.mode === "cloud" && <p className="form-description">{extractionProviderLabel(status)} processes the image. Use fictional documents only.</p>}
          {reading && <span className="intake-progress" role="status"><Spinner/>Reading replacement document</span>}
          {readError && <InlineError message={readError}/>}
          <DocumentFields kind={kind} value={document} update={setDocument} optional={kind !== "gst"}
            placeholder={kind === "gst" ? undefined : app.submission.documents[kind].value}/>
          {needsEvidence && !document.assessmentReceipt && <label className="agent-confirm">
            <input type="checkbox" checked={confirmManual} onChange={event => setConfirmManual(event.target.checked)}/>
            <span>I checked the values against a clear replacement document.</span></label>}
        </Section>
        <div className="form-actions"><Link href={root} className="button secondary">Cancel</Link>
          <button className="button primary" type="submit" disabled={busy || reading}>{busy && <Spinner/>}Resubmit information</button></div>
      </div>
      <aside className="panel form-aside"><span className="check-icon"><FileText size={19}/></span>
        <h2>{app.correction ? "Reviewer request" : "Bank re-verification"}</h2><p>{app.correction?.reason ??
          "Changes to bank details require a new verification. Other valid checks will be retained."}</p></aside>
    </form>
  </>;
}
