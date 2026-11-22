import Link from "next/link";
import { ArrowUpRight, ClipboardCheck, Inbox } from "lucide-react";
import type { InboxData } from "@/lib/access";
import { timestamp } from "./ui";

export function MerchantInbox({ data }: { data: InboxData }) {
  const items = [...data.items.filter(item => item.open), ...data.items.filter(item => !item.open)];
  return <>
    <div className="page-heading">
      <div><h1>Inbox</h1><p>Read the reviewer’s feedback and send corrected evidence.</p></div>
    </div>
    {!items.length ? <section className="panel empty-state inbox-empty">
      <span className="empty-icon"><Inbox size={22}/></span>
      <h2>No correction requests</h2>
      <p>When a reviewer asks for changes, you’ll see the reason here.</p>
      <Link href="/applications" className="button secondary small">My applications</Link>
    </section> : <section aria-label="Correction requests" className="inbox-list">
      {items.map(item => <article className="panel inbox-card" key={item.id}>
        <span className="check-icon inbox-icon"><ClipboardCheck size={18}/></span>
        <div className="inbox-message">
          <div className="inbox-meta">
            <span className={`status ${item.open ? "amber" : "green"}`}><span className="status-dot"/>{item.open ? "Action required" : "Correction submitted"}</span>
            <time dateTime={new Date(item.requestedAt).toISOString()}>{timestamp(item.requestedAt)}</time>
          </div>
          <h2>{item.field}</h2>
          <div className="inbox-reference"><strong>{item.applicationName}</strong><span className="mono">{item.applicationId}</span></div>
          <p>{item.reason}</p>
        </div>
        <Link href={`/applications/${item.applicationId}${item.open ? "/correct" : ""}`}
          className={`button ${item.open ? "primary" : "secondary"} small inbox-action`}>
          {item.open ? "Review and correct" : "View application"}<ArrowUpRight size={14}/>
        </Link>
      </article>)}
    </section>}
  </>;
}
