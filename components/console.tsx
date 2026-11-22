"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipboardList, FlaskConical, Inbox, ListChecks, LogOut, Menu, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { workspaceHome, type InboxData, type SessionUser } from "@/lib/access";
import { filters, type Application, type CheckKind, type Filter } from "@/lib/model";
import { DemoControls } from "./demo";
import { Detail } from "./detail";
import { MerchantInbox } from "./merchant-inbox";
import { Queue, type QueueData } from "./queue";
import { Correction, MissingInformationForm, NewApplication, RelayRequestError, requestJson, Submission } from "./submission";
import { Crumb, InlineError, Loading, RelayLogo, Toast } from "./ui";

type Resource = { key: string; data?: QueueData | Application | InboxData; error?: string };
function errorMessage(error: unknown) {
  if (error instanceof TypeError) return "The workspace could not be reached. Check your connection and try again.";
  return error instanceof Error ? error.message : "The request was interrupted. Try again.";
}

export function Console({ path, user, intakeChecks }: { path: string[]; user: SessionUser; intakeChecks: CheckKind[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const owner = user.role === "owner";
  const home = workspaceHome(user.role);
  const [section, id, view, ...rest] = path;
  const isQueue = (owner ? section === "manager" : section === "applications") && !id;
  const isNew = !owner && section === "applications" && id === "new" && !view;
  const isInbox = !owner && section === "inbox" && !id;
  const isApplication = section === "applications" && !!id && id !== "new" &&
    (!view || view === "submission" || view === "correct") && !rest.length;
  const isMissing = !isQueue && !isNew && !isApplication && !isInbox;
  const key = isApplication ? id : isInbox ? "inbox" : "";
  const endpoint = `/api/relay${key ? `/${encodeURIComponent(key)}` : ""}`;
  const filter = (filters.find(item => item.key === params.get("filter"))?.key ?? "all") as Filter;
  const [resource, setResource] = useState<Resource>();
  const [now, setNow] = useState(0);
  const [reload, setReload] = useState(0);
  const [mobileNav, setMobileNav] = useState(false);
  const [demoOpen, setDemoOpen] = useState(false);
  const [toast, setToast] = useState("");
  const [demoMessage, setDemoMessage] = useState("");
  const [operatorError, setOperatorError] = useState("");
  const [demoError, setDemoError] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState("");
  const [inboxCount, setInboxCount] = useState(0);
  const revision = useRef(0);
  const lock = useRef(false);
  const activeKey = useRef(key);

  useEffect(() => {
    activeKey.current = key;
    setMobileNav(false);
    setOperatorError("");
    setDemoError("");
    setDemoMessage("");
  }, [key, view]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 6000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (isMissing) return;
    const controller = new AbortController();
    let timer: number;
    let initial = true;
    async function load() {
      const requestRevision = revision.current;
      try {
        const data = await requestJson<QueueData | Application | InboxData>(endpoint, undefined, controller.signal);
        if (!controller.signal.aborted && revision.current === requestRevision && !lock.current) {
          setResource({ key, data });
          setNow(Date.now());
          if ("openCount" in data) setInboxCount(data.openCount);
          initial = false;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof RelayRequestError && error.status === 401) {
          window.location.replace("/");
          return;
        }
        if (initial && revision.current === requestRevision) {
          setResource(previous => previous?.key === key && previous.data ? previous : { key, error: errorMessage(error) });
        }
      }
      if (!controller.signal.aborted) timer = window.setTimeout(load, key ? 1000 : 2400);
    }
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [endpoint, isMissing, key, reload]);

  useEffect(() => {
    if (owner || isInbox || isMissing) return;
    const controller = new AbortController();
    let timer: number;
    async function updateCount() {
      try {
        const data = await requestJson<InboxData>("/api/relay/inbox", undefined, controller.signal);
        if (!controller.signal.aborted) setInboxCount(data.openCount);
      } catch {
        // The active page reports connection and session errors.
      }
      if (!controller.signal.aborted) timer = window.setTimeout(updateCount, 8000);
    }
    void updateCount();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [owner, isInbox, isMissing]);

  const data = resource?.key === key ? resource.data : undefined;
  const queue = data && "rows" in data ? data : undefined;
  const app = data && "activity" in data ? data : undefined;
  const inbox = data && "items" in data ? data : undefined;
  const counts = data && "counts" in data ? data.counts : undefined;
  const loadError = resource?.key === key ? resource.error : undefined;
  const showDemo = owner && (demoOpen || params.get("demo") === "1");
  const applicationsActive = !isInbox && (!owner || !(isQueue && filter === "attention"));
  const initials = user.name.split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join("").toUpperCase();

  async function run(payload: Record<string, unknown>, simulator = false) {
    if (lock.current || !app) return false;
    lock.current = true;
    revision.current++;
    setBusy(true);
    const setError = simulator ? setDemoError : setOperatorError;
    setError("");
    try {
      if (simulator) {
        const result = await requestJson<{ application: Application; message: string }>(`${endpoint}/demo`, payload);
        if (activeKey.current === key) {
          setResource({ key, data: result.application });
          setDemoMessage(result.message);
        }
      } else {
        const result = await requestJson<Application>(endpoint, payload);
        if (activeKey.current === key) {
          setResource({ key, data: result });
          const messages: Record<string, string> = {
            requestCorrection: "Correction request sent.",
            requestMissing: "Request for missing information sent.",
            correct: "Changes submitted for verification.",
            correctMissing: "Requested information submitted.",
            clearDuplicate: "Duplicate hold cleared.",
            closeDuplicate: "Application closed as a duplicate.",
            approve: "Application approved. Merchant ID setup started.",
            retryCheck: "A new verification attempt was queued.",
            retrySetup: "Merchant ID setup retry queued.",
          };
          setToast(messages[String(payload.action)]);
        }
      }
      return true;
    } catch (error) {
      if (activeKey.current === key) setError(errorMessage(error));
      return false;
    } finally {
      revision.current++;
      lock.current = false;
      setBusy(false);
    }
  }

  function closeDemo() {
    setDemoOpen(false);
    setDemoError("");
    setDemoMessage("");
    if (params.get("demo") === "1" && app) router.replace(`/applications/${app.id}`, { scroll: false });
  }

  async function signOut() {
    setSigningOut(true);
    setSignOutError("");
    try {
      await requestJson("/api/relay/session", { action: "signOut" });
      window.location.replace("/");
    } catch (error) {
      setSignOutError(errorMessage(error));
      setSigningOut(false);
    }
  }

  async function submitCorrection(kind: CheckKind, input: Record<string, unknown>) {
    const success = await run({ action: "correct", kind, input });
    if (success) router.push(`/applications/${id}/submission`);
    return success;
  }

  async function submitMissingInformation(input: Record<string, unknown>) {
    const success = await run({ action: "correctMissing", input });
    if (success) router.push(`/applications/${id}/submission`);
    return success;
  }

  return <div className="app-shell">
    <a href="#workspace" className="skip-link">Skip to workspace</a>
    {mobileNav && <button className="mobile-scrim" onClick={() => setMobileNav(false)} aria-label="Close navigation"/>}
    <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`} id="workspace-navigation">
      <Link href={home} className="brand" aria-label="Relay home" onClick={() => setMobileNav(false)}>
        <RelayLogo subtitle={owner ? "Merchant operations" : "Merchant workspace"}/>
      </Link>
      <div className="sidebar-content">
        <h2>Workspace</h2>
        <nav aria-label="Workspace navigation">
          <Link href={home} onClick={() => setMobileNav(false)}
            className={`nav-link ${applicationsActive ? "current" : ""}`}
            aria-current={applicationsActive ? "page" : undefined}>
            <ClipboardList size={18}/><span>{owner ? "Applications" : "My applications"}</span>
          </Link>
          {owner ? <Link href="/manager?filter=attention" onClick={() => setMobileNav(false)}
            className={`nav-link ${isQueue && filter === "attention" ? "current" : ""}`}
            aria-current={isQueue && filter === "attention" ? "page" : undefined}>
            <ListChecks size={18}/><span>Review queue</span>{counts && <span className="nav-count">{counts.attention}</span>}
          </Link> : <Link href="/inbox" onClick={() => setMobileNav(false)}
            className={`nav-link ${isInbox ? "current" : ""}`} aria-current={isInbox ? "page" : undefined}>
            <Inbox size={18}/><span>Inbox</span>{inboxCount > 0 && <span className="nav-count" aria-label={`${inboxCount} open requests`}>{inboxCount}</span>}
          </Link>}
        </nav>
      </div>
      <div className="sidebar-bottom">
        <div className="sidebar-environment"><span className="env-dot"/><div><strong>Sandbox workspace</strong><small>Simulated providers</small></div></div>
        <div className="sidebar-profile"><span className="avatar" aria-hidden="true">{initials}</span>
          <div className="profile-text"><strong title={user.name}>{user.name}</strong><small>{owner ? "Manager" : "Merchant"}</small></div></div>
      </div>
    </aside>
    <div className="app-body">
      <header className="topbar">
        <div className="breadcrumbs">
          <button className="icon-button mobile-menu" aria-label="Toggle navigation" aria-expanded={mobileNav}
            aria-controls="workspace-navigation" onClick={() => setMobileNav(value => !value)}><Menu size={22}/></button>
          <span className="crumb-root">{owner ? "Manager workspace" : "Merchant workspace"}</span><Crumb>{isInbox ? "Inbox" : "Applications"}</Crumb>
          {app && <Crumb>{app.id}</Crumb>}{isNew && <Crumb>New application</Crumb>}
        </div>
        <div className="workspace-actions">
          {owner && <button className="button demo-button" onClick={() => { setDemoOpen(true); setDemoMessage(""); }}>
            <FlaskConical size={16}/>Demo controls
          </button>}
          <button className="button secondary small" disabled={signingOut} onClick={() => void signOut()}><LogOut size={15}/>Sign out</button>
        </div>
      </header>
      <main id="workspace" tabIndex={-1} className="workspace">
        {signOutError && <InlineError message={signOutError} retry={() => void signOut()}/>}
        {isMissing && <div className="route-error"><ShieldAlert size={26}/><h1>Page unavailable</h1><Link href={home} className="button primary">Open applications</Link></div>}
        {isNew && <NewApplication requiredChecks={intakeChecks}
          onCreated={id => { setToast("Application submitted."); router.push(`/applications/${id}/submission`); }}/>}
        {!isMissing && !isNew && !data && (loadError ? <>
          <div className="page-heading"><h1>{isInbox ? "Inbox" : isQueue ? "Applications" : "Application unavailable"}</h1></div>
          <InlineError message={loadError} retry={() => setReload(value => value + 1)}/>
          {!isQueue && <Link className="button secondary small error-back" href={home}>Return to applications</Link>}
        </> : <Loading/>)}
        {isQueue && queue && <Queue data={queue} filter={filter} now={now} owner={owner}/>}
        {isInbox && inbox && <MerchantInbox data={inbox}/>}
        {isApplication && app && <>
          {!view && owner && <Detail key={app.id} application={app} operate={run} busy={busy} error={operatorError}/>}
          {(view === "submission" || (!view && !owner)) && <Submission app={app} owner={owner}/>}
          {view === "correct" && !owner && <>
            {operatorError && <InlineError message={operatorError}/>}
            {app.correction?.kind === "missing" ?
              <MissingInformationForm key={`${app.id}-${app.correction.items.join(",")}`} app={app} onSubmit={submitMissingInformation}/> :
              <Correction key={`${app.id}-${app.correction?.kind ?? "bank"}`} app={app}
                kind={params.get("check") === "bank" ? "bank" : app.correction?.kind ?? "bank"} onSubmit={submitCorrection}/>}
          </>}
        </>}
      </main>
    </div>
    {showDemo && <DemoControls key={app?.id ?? "queue"} app={app} queue={queue} close={closeDemo}
      action={async payload => { await run(payload, true); }} busy={busy} error={demoError} message={demoMessage}/>}
    {toast && <Toast message={toast} dismiss={() => setToast("")}/>}
  </div>;
}
