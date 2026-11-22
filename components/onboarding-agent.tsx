"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Building2, CircleCheck, CircleHelp, FileText, Fingerprint, Landmark, Sparkles, Upload } from "lucide-react";
import { checkKinds, type CheckKind } from "@/lib/model";
import { extractionGuides, extractionLabels, extractionProviderLabel, sensitiveFields, type ExtractedDocument, type ExtractionField, type ExtractionStatus } from "@/lib/onboarding";
import { DocumentReadError, makeSampleDocument, readDocument } from "./document-files";
import { InlineError, Spinner } from "./ui";

type ReadState = { name: string; result?: ExtractedDocument; error?: string; status?: number };

const icons = { pan: Fingerprint, gst: Building2, bank: Landmark };

export function useExtractionStatus() {
  const [status, setStatus] = useState<ExtractionStatus | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/extract", { cache: "no-store", signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error("Unavailable");
        return response.json();
      })
      .then(data => setStatus(data as ExtractionStatus))
      .catch(() => {
        if (!controller.signal.aborted) setStatus({ enabled: false, provider: "ollama", mode: "cloud", model: "" });
      });
    return () => controller.abort();
  }, []);
  return status;
}

export function DocumentPicker({ kind, disabled, label, choose }: {
  kind: CheckKind; disabled?: boolean; label: string; choose: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <input ref={input} className="sr-only" tabIndex={-1} type="file" disabled={disabled}
      accept=".pdf,.jpg,.jpeg,.png" aria-label={`Upload ${extractionGuides[kind].title}`}
      onChange={event => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (file) choose(file);
      }}/>
    <button type="button" className="button secondary small" disabled={disabled} onClick={() => input.current?.click()}>
      <Upload size={15}/>{label}
    </button>
  </>;
}

function displayCandidate(key: ExtractionField, value: string) {
  return sensitiveFields.includes(key) ? `•••• ${value.slice(-4)}` : value;
}

function missingFields(result: ExtractedDocument) {
  return extractionGuides[result.kind].fields.filter(field => !result.values[field]);
}

function feedback(result: ExtractedDocument) {
  const title = extractionGuides[result.kind].title;
  if (result.readability === "wrong_document") return `This looks like a different document. Upload your ${title.toLowerCase()}.`;
  if (result.readability === "unreadable") return "I couldn’t read the required fields. Upload a sharper copy or enter the values yourself.";
  const missing = missingFields(result).map(field => extractionLabels[field]);
  return missing.length
    ? `I couldn’t read ${missing.join(" or ")}. Upload a clearer copy or enter the missing values when you review.`
    : "I found all the expected fields. Check the extracted values before submitting.";
}

export function AgentIntake({ status, onReview, onSample, onReading, onResult }: {
  status: ExtractionStatus | null;
  onReview: () => void;
  onSample: () => void;
  onReading: (reading: boolean) => void;
  onResult: (kind: CheckKind, result?: ExtractedDocument, previous?: ExtractedDocument) => void;
}) {
  const [slots, setSlots] = useState<Partial<Record<CheckKind, ReadState>>>({});
  const [active, setActive] = useState<CheckKind | null>(null);
  const [recent, setRecent] = useState<CheckKind | null>(null);
  const [running, setRunning] = useState(false);
  const [sampleError, setSampleError] = useState("");
  const selectedFiles = useRef<Partial<Record<CheckKind, File>>>({});
  const selectedResults = useRef<Partial<Record<CheckKind, ExtractedDocument>>>({});
  const activeJob = useRef<AbortController>(null);

  useEffect(() => () => activeJob.current?.abort(), []);

  async function extract(kind: CheckKind, file: File, signal: AbortSignal) {
    signal.throwIfAborted();
    setActive(kind);
    setRecent(kind);
    const previous = selectedResults.current[kind];
    delete selectedResults.current[kind];
    selectedFiles.current[kind] = file;
    const name = file.type === "application/pdf" || /\.pdf$/i.test(file.name) ? "PDF document" : "Image attachment";
    setSlots(current => ({ ...current, [kind]: { name } }));
    onResult(kind, undefined, previous);
    try {
      const result = await readDocument(file, kind, signal);
      if (signal.aborted) return false;
      setSlots(current => ({ ...current, [kind]: { name, result } }));
      selectedResults.current[kind] = result;
      onResult(kind, result);
      return true;
    } catch (error) {
      const status = error instanceof DocumentReadError ? error.status : undefined;
      if (!signal.aborted) setSlots(current => ({ ...current, [kind]: {
        name,
        error: error instanceof Error ? error.message : "Try another document or enter your details manually.",
        status,
      } }));
      return status !== 402 && status !== 429 && status !== 503;
    }
  }

  async function run(work: (signal: AbortSignal) => Promise<unknown>) {
    if (activeJob.current || !status?.enabled) return;
    const job = new AbortController();
    activeJob.current = job;
    onReading(true);
    setRunning(true);
    setSampleError("");
    try {
      await work(job.signal);
    } catch {
      if (!job.signal.aborted) setSampleError("Relay could not prepare the sample documents. Try again or use the sample application.");
    } finally {
      if (!job.signal.aborted) {
        setActive(null);
        setRunning(false);
        onReading(false);
      }
      activeJob.current = null;
    }
  }

  const count = checkKinds.filter(kind => {
    const result = slots[kind]?.result;
    return result?.readability === "readable" && !missingFields(result).length;
  }).length;
  const hasValues = checkKinds.some(kind => Object.keys(slots[kind]?.result?.values ?? {}).length);
  const latest = recent ? slots[recent] : undefined;
  const next = checkKinds.find(kind => !slots[kind]);
  const openRouter = status?.provider === "openrouter";

  return <div className="intake-layout">
    <section className="panel intake-panel" aria-labelledby="intake-title">
      <div className="intake-panel-heading">
        <div><h2 id="intake-title">Start with supporting documents</h2><p>Upload PNG, JPEG or PDF. Up to 8 MB per document and two pages per PDF.</p></div>
        <button className="button secondary small" type="button" disabled={!status?.enabled || running}
          onClick={() => void run(async signal => {
            onSample();
            for (const kind of checkKinds) {
              if (!(await extract(kind, await makeSampleDocument(kind), signal))) break;
            }
          })}><FileText size={15}/>Use sample documents</button>
      </div>
      <div className="intake-rows">
        {checkKinds.map(kind => {
          const guide = extractionGuides[kind];
          const Icon = icons[kind];
          const slot = slots[kind];
          const result = slot?.result;
          const reading = active === kind && !result && !slot?.error;
          const needsInput = Boolean(result && (result.readability !== "readable" || missingFields(result).length));
          return <section key={kind} className="intake-row" aria-labelledby={`intake-${kind}`}>
            <div className="intake-row-head">
              <span className="check-icon"><Icon size={18}/></span>
              <div className="intake-row-title"><h3 id={`intake-${kind}`}>{guide.title}</h3><p>{guide.hint}</p></div>
              {reading && <span className="intake-progress"><Spinner/>Reading document</span>}
              {result && <span className={`status ${needsInput ? "amber" : "teal"}`}><span className="status-dot"/>
                {needsInput ? "Needs input" : "Fields extracted"}
              </span>}
              <div className="intake-row-action">
                <DocumentPicker kind={kind} label={slot ? "Replace" : "Upload"} disabled={!status?.enabled || running}
                  choose={file => void run(signal => extract(kind, file, signal))}/>
              </div>
            </div>
            {slot && <div className="intake-file"><FileText size={14}/><span>{slot.name}</span></div>}
            {slot?.error && <InlineError message={slot.error} retry={running || slot.status === 402 ? undefined : () => {
              const file = selectedFiles.current[kind];
              if (file) void run(signal => extract(kind, file, signal));
            }}/>}
            {result && <div className="extraction-result">
              {Object.keys(result.values).length > 0 && <dl>{guide.fields.map(field => {
                const value = result.values[field];
                return value ? <div key={field}><dt>{extractionLabels[field]}</dt>
                  <dd className={sensitiveFields.includes(field) ? "mono" : ""}>{displayCandidate(field, value)}</dd></div> : null;
              })}</dl>}
              {needsInput && <p>{feedback(result)}</p>}
            </div>}
          </section>;
        })}
        {sampleError && <InlineError message={sampleError}/>}
      </div>
      <div className="intake-footer">
        <span>{count} of 3 documents ready for review</span>
        <button className="button primary" type="button" disabled={running} onClick={onReview}>
          {hasValues ? "Review application" : "Continue with manual entry"}<ArrowRight size={16}/>
        </button>
      </div>
    </section>
    <aside className="panel agent-panel" aria-labelledby="onboarding-agent-title">
      <div className="agent-panel-heading">
        <span className="agent-mark"><Sparkles size={19}/></span>
        <div><h2 id="onboarding-agent-title">Onboarding agent</h2>
          <p>{status?.enabled ? `${extractionProviderLabel(status)} · ${latest?.result?.model ?? status.model}` : "Guided document intake"}</p></div>
      </div>
      <div className="agent-messages" aria-live="polite">
        <p className="agent-message">I can pull details from your documents and flag any fields you’ll need to fill in.</p>
        {running ? <p className="agent-message">{active ? `I’m reading the ${extractionGuides[active].title.toLowerCase()}.` : "I’m preparing the documents."}</p>
          : latest?.result ? <p className="agent-message">{feedback(latest.result)}</p>
            : latest?.error ? <p className="agent-message">{latest.status === 402
              ? <>Check your <a className="agent-billing-link" href={openRouter ? "https://openrouter.ai/settings/keys" : "https://ollama.com/settings"} target="_blank" rel="noreferrer">
                {openRouter ? "OpenRouter account and key" : "Ollama balance"}</a>, or use the sample application to continue without cloud extraction.</>
              : latest.status === 429
                ? "Your selected file is still attached. Use Try again when the service is ready."
                : "Try another copy of this document or continue with manual entry."}
            </p>
              : next && status?.enabled ? <p className="agent-message">Start with the {extractionGuides[next].title.toLowerCase()}, or try the fictional sample documents.</p> : null}
        {!running && latest?.result && missingFields(latest.result).length === 0 && next &&
          <p className="agent-message">Next, upload the {extractionGuides[next].title.toLowerCase()}.</p>}
      </div>
      <div className="agent-notice">
        {status?.enabled
          ? <><CircleCheck size={16}/><span>{status.mode === "cloud" ? `Document images go to ${extractionProviderLabel(status)}. Upload fictional documents only.` : "Document images are processed by your local Ollama instance."}</span></>
          : <><CircleHelp size={16}/><span>{openRouter
            ? <>Set <code>OPENROUTER_API_KEY</code> in <code>.env.local</code> and restart Relay to enable free cloud extraction.</>
            : status ? "AI extraction is unavailable. You can use the sample application or enter details manually." : "Checking document extraction availability…"}</span></>}
      </div>
    </aside>
  </div>;
}
