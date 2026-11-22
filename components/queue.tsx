"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, ChevronRight, ListFilter, Plus, Search, X } from "lucide-react";
import { filters, matchesFilter, type Counts, type Filter, type QueueRow, type WorkflowMetrics } from "@/lib/model";
import { elapsed, MerchantMark, Status, timestamp, updated } from "./ui";

export type QueueData = { rows: QueueRow[]; counts: Counts; metrics?: WorkflowMetrics };

export function Queue({ data, filter, now, owner }: { data: QueueData; filter: Filter; now: number; owner: boolean }) {
  const [query, setQuery] = useState("");
  const [oldestFirst, setOldestFirst] = useState(false);
  const needle = query.trim().toLowerCase();
  const rows = data.rows.filter(row =>
    matchesFilter(row, filter) &&
    (row.name.toLowerCase().includes(needle) || row.id.toLowerCase().includes(needle)),
  );
  if (oldestFirst) rows.reverse();
  const home = owner ? "/manager" : "/applications";
  const firstApplication = !owner && !data.counts.all;

  return <>
    <div className="page-heading queue-heading">
      <div><h1>{owner ? "Manager dashboard" : "My applications"}</h1>
        <p>{owner ? "Review merchant applications and resolve verification exceptions." : "Track your submissions and see what needs your attention."}</p></div>
      {!owner && <Link href="/applications/new" className="button primary"><Plus size={17} />New application</Link>}
    </div>

    {owner && data.metrics && <dl className="workflow-metrics" aria-label="Workflow metrics">
      <div><dt>7-day exception rate</dt><dd><strong>{data.metrics.submitted
        ? new Intl.NumberFormat("en-IN", { style: "percent", maximumFractionDigits: 1 }).format(data.metrics.exceptions / data.metrics.submitted)
        : "—"}</strong> <span>{data.metrics.exceptions} of {data.metrics.submitted} submissions</span></dd></div>
      <div><dt>Current dead letters</dt><dd><strong>{data.metrics.deadLetters}</strong></dd></div>
    </dl>}

    <section className="queue-card" aria-label="Applications work queue">
      <div className="queue-toolbar">
        <nav className="filter-tabs" aria-label="Filter applications">
          {filters.map(option => <Link key={option.key} href={option.key === "all" ? home : `${home}?filter=${option.key}`}
            scroll={false} className={`filter-tab ${filter === option.key ? "selected" : ""}`}
            aria-current={filter === option.key ? "page" : undefined}>
            {!owner && option.key === "attention" ? "Review & actions" : option.label}<span className="tab-count">{data.counts[option.key]}</span>
          </Link>)}
        </nav>
        <div className="search-field">
          <Search size={17} aria-hidden="true" />
          <input aria-label="Search applications" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search name or ID…" />
          {query && <button className="icon-button clear-search" onClick={() => setQuery("")} aria-label="Clear search input"><X size={15} /></button>}
        </div>
      </div>

      {rows.length ? <div className="table-scroll">
        <table className="applications-table">
          <thead><tr>
            <th scope="col">Merchant</th><th scope="col">Application ID</th><th scope="col">Status</th>
            <th scope="col">Blocker / next step</th><th scope="col">Time in state</th>
            <th scope="col" aria-sort={oldestFirst ? "ascending" : "descending"}>
              <button className="sort-button" onClick={() => setOldestFirst(value => !value)}>Last updated <ArrowDown size={13} className={oldestFirst ? "reversed" : ""}/></button>
            </th><th scope="col" className="row-end"><span className="sr-only">Open</span></th>
          </tr></thead>
          <tbody>{rows.map(row => {
            const href = `/applications/${row.id}`;
            return <tr key={row.id}>
              <td className="merchant-cell"><Link href={href} className="merchant-link" aria-label={`Open ${row.name}, ${row.id}`}>
                <MerchantMark name={row.name} /><span className="merchant-copy"><strong>{row.name}</strong>
                  <span>{[row.sector, row.city].filter(Boolean).join(" · ")}</span></span>
              </Link></td>
              <td className="application-id"><span className="mono">{row.id}</span></td>
              <td className="row-status"><Status row={row} /></td>
              <td className="row-blocker"><span className={row.state === "review" || row.state === "incomplete" || row.setup === "failed" ? "blocker-alert" : ""}>{row.blocker}</span></td>
              <td className="state-time">{elapsed(row.state_at, now)}</td>
              <td className="row-updated"><time title={timestamp(row.updated_at)} dateTime={new Date(row.updated_at).toISOString()}>{updated(row.updated_at, now)}</time></td>
              <td className="row-end"><ChevronRight size={17} aria-hidden="true" /></td>
            </tr>;
          })}</tbody>
        </table>
      </div> : <div className="empty-state">
        <span className="empty-icon">{needle ? <Search size={22}/> : <ListFilter size={22}/>}</span>
        <h2>{needle ? "No matching applications" : firstApplication ? "No applications yet" : "No applications in this view"}</h2>
        <p>{needle ? "Try another merchant name or an application ID." : firstApplication
          ? "Submit your first application to start merchant verification." : "Open All applications to see the rest of the queue."}</p>
        {needle ? <button className="button secondary small" onClick={() => setQuery("")}>Clear search</button>
          : !firstApplication && <Link href={home} className="button secondary small">All applications <ArrowRight size={15}/></Link>}
      </div>}

      <div className="table-footer">
        <span>Showing <strong>{rows.length}</strong> of <strong>{data.counts[filter]}</strong> applications</span>
        <span>Times shown in IST</span>
      </div>
    </section>
  </>;
}
