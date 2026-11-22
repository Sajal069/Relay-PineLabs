"use client";

import Link from "next/link";
import { AlertCircle, ArrowLeft, Check, ChevronRight, LoaderCircle } from "lucide-react";
import { stateLabels, type QueueRow } from "@/lib/model";

const age = new Intl.RelativeTimeFormat("en-IN", { numeric: "always", style: "short" });
const time = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
});
const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

export function elapsed(when: number, now: number) {
  const minutes = Math.max(Math.floor((now - when) / 60_000), 0);
  if (minutes === 0) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes / 60) % 24}h`;
}

export function updated(when: number, now: number) {
  const minutes = Math.max(Math.floor((now - when) / 60_000), 0);
  if (minutes === 0) return "Just now";
  if (minutes < 60) return age.format(-minutes, "minute");
  if (date.format(when) === date.format(now)) return `Today, ${time.format(when)}`;
  return `${date.format(when)}, ${time.format(when)}`;
}

export function timestamp(when: number) {
  return `${date.format(when)}, ${time.format(when)} IST`;
}

export function Status({ row }: { row: Pick<QueueRow, "state" | "setup"> }) {
  const label = row.state === "approved" && row.setup === "failed" ? "Approved · Setup failed" : stateLabels[row.state];
  const tone = row.setup === "failed" ? "danger"
    : { incomplete: "amber", review: "amber", correction: "amber", verifying: "blue", ready: "teal", approved: "green", closed_duplicate: "danger" }[row.state];
  return <span className={`status ${tone}`}><span className="status-dot" />{label}</span>;
}

export function MerchantMark({ name, large = false }: { name: string; large?: boolean }) {
  const words = name.match(/[\p{L}\p{N}]+/gu) ?? [];
  const [first = "", second] = words;
  const initials = (second ? first.slice(0, 1) + second.slice(0, 1) : first.slice(0, 2) || "…").toUpperCase();
  const tones = ["indigo", "green", "rose", "amber", "blue", "violet"];
  const hash = Array.from(name).reduce((value, letter) => (value * 31 + letter.charCodeAt(0)) >>> 0, 0);
  return <span aria-hidden="true" className={`merchant-mark ${tones[hash % tones.length]} ${large ? "large" : ""}`}>{initials}</span>;
}

export function InlineError({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="inline-error" role="alert"><AlertCircle size={18} /><span>{message}</span>
    {retry && <button className="button secondary small" onClick={retry}>Try again</button>}
  </div>;
}

export function Loading() {
  return <div className="loading-view" aria-busy="true" role="status">
    <div className="skeleton skeleton-title" /><div className="skeleton skeleton-subtitle" />
    <div className="skeleton skeleton-table" /><span className="sr-only">Loading applications</span>
  </div>;
}

export function Spinner() {
  return <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />;
}

export function RelayLogo({ subtitle }: { subtitle: string }) {
  return <>
    <svg className="brand-icon" aria-hidden="true" viewBox="0 0 48 48">
      <rect width="48" height="48" rx="11" fill="currentColor"/>
      <path d="M11 29h7l8-13h11M11 35h11l8-13h7" fill="none" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
    <span><strong>relay<span className="brand-period">.</span></strong><small>{subtitle}</small></span>
  </>;
}

export function BackLink({ href = "/", children = "Applications" }: { href?: string; children?: React.ReactNode }) {
  return <Link href={href} className="back-link"><ArrowLeft size={15} />{children}</Link>;
}

export function Crumb({ children }: { children: React.ReactNode }) {
  return <><ChevronRight size={14} className="crumb-chevron" /><span className="crumb-current">{children}</span></>;
}

export function Toast({ message, dismiss }: { message: string; dismiss: () => void }) {
  return <div role="status" className="toast"><span className="toast-mark"><Check size={15}/></span>{message}
    <button onClick={dismiss} className="toast-close" aria-label="Dismiss notification">×</button>
  </div>;
}
