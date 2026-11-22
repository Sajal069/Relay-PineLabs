export const checkKinds = ["pan", "gst", "bank"] as const;
export type CheckKind = (typeof checkKinds)[number];
export type State = "incomplete" | "verifying" | "review" | "correction" | "ready" | "approved" | "closed_duplicate";
export type CheckStatus = "pending" | "passed" | "failed" | "timed_out";
export type SetupStatus = "idle" | "pending" | "failed" | "active";

export const transitions: Record<State, readonly State[]> = {
  incomplete: ["correction", "closed_duplicate"],
  verifying: ["review", "ready", "incomplete", "closed_duplicate"],
  review: ["correction", "verifying", "ready", "incomplete", "closed_duplicate"],
  correction: ["verifying", "incomplete", "review", "ready", "closed_duplicate"],
  ready: ["approved", "verifying", "review", "incomplete", "closed_duplicate"],
  approved: [],
  closed_duplicate: [],
};

export const stateLabels: Record<State, string> = {
  incomplete: "Missing information",
  verifying: "Verifying",
  review: "Needs review",
  correction: "Awaiting correction",
  ready: "Ready to approve",
  approved: "Approved",
  closed_duplicate: "Closed as duplicate",
};

export const checkDetails = {
  pan: { label: "PAN verification", provider: "PAN registry simulator", field: "PAN" },
  gst: { label: "GST verification", provider: "GST registry simulator", field: "GST legal name" },
  bank: { label: "Bank account", provider: "Bank verification simulator", field: "Bank account number" },
};

export const checkLabels: Record<CheckStatus, string> = {
  pending: "Pending",
  passed: "Verified",
  failed: "Failed",
  timed_out: "Timed out",
};

export type DocumentInput = { value: string; quality: "clear" | "blurred"; receipt?: string; assessmentReceipt?: string };
export type ExtractionSource = { source: "ollama" | "openrouter"; model: string };
export type ExtractionAssessment = { status: "complete" | "partial" | "unreadable" | "wrong_document"; missing: string[] };
export const intakeLabels = {
  name: "Merchant display name", city: "City", sector: "Business category", legalName: "Registered legal name",
  signatory: "Signatory name", pan: "PAN", gstin: "GSTIN", account: "Bank account number", ifsc: "IFSC",
  "documents.pan": "PAN card", "documents.gst": "GST certificate", "documents.bank": "Bank proof",
} as const;
export type IntakeItem = keyof typeof intakeLabels;
export type DuplicateMatch = { applicationId: string; name: string; reasons: string[]; cleared: boolean };
export type WorkflowMetrics = { submitted: number; exceptions: number; deadLetters: number };
export type FormInput = {
  name: string;
  city: string;
  sector: string;
  legalName: string;
  gstin: string;
  signatory: string;
  pan: string;
  account: string;
  ifsc: string;
  documents: Record<CheckKind, DocumentInput>;
};

export type FieldValue = { masked: string; fingerprint: string };
export type StoredInput = Omit<FormInput, "gstin" | "pan" | "account" | "ifsc" | "documents"> & {
  gstin: FieldValue;
  pan: FieldValue;
  account: FieldValue;
  ifsc: FieldValue;
  documents: Record<CheckKind, { value: FieldValue; quality: DocumentInput["quality"]; extraction?: ExtractionSource; assessment?: ExtractionAssessment }>;
};

export type Evidence = {
  submitted: string;
  extracted: string;
  provider: string | null;
  confidence: number | null;
  extraction?: ExtractionSource;
  reason: string;
};

export type Check = {
  id: string;
  kind: CheckKind;
  status: CheckStatus;
  requested_at: number;
  updated_at: number;
  delivery: "held" | "scheduled" | "received" | "dead";
  current: boolean;
  evidence: Evidence;
};

export type QueueRow = {
  id: string;
  name: string;
  city: string;
  sector: string;
  state: State;
  state_at: number;
  updated_at: number;
  setup: SetupStatus;
  blocker: string;
};

export type Application = QueueRow & {
  submission: Omit<StoredInput, "gstin" | "pan" | "account" | "ifsc" | "documents"> &
    Record<"gstin" | "pan" | "account" | "ifsc", string> & {
      documents: Record<CheckKind, DocumentInput>;
    };
  correction: { kind: CheckKind | "missing"; reason: string; items: IntakeItem[] } | null;
  missing: IntakeItem[];
  requiredChecks: CheckKind[];
  duplicates: DuplicateMatch[];
  evidenceIssues: { kind: CheckKind; reason: string; blocking: boolean }[];
  merchant_id: string | null;
  fail_next: boolean;
  checks: Check[];
  attempts: Check[];
  activity: { id: number; title: string; description: string; actor: string; at: number }[];
  counts: Counts;
};

export type Counts = { all: number; attention: number; verifying: number; approved: number };
export type Filter = keyof Counts;
export const filters: { key: Filter; label: string }[] = [
  { key: "all", label: "All applications" },
  { key: "attention", label: "Needs attention" },
  { key: "verifying", label: "Verifying" },
  { key: "approved", label: "Approved" },
];

export function matchesFilter(row: Pick<QueueRow, "state" | "setup">, filter: Filter) {
  if (filter === "all") return true;
  if (filter === "attention") {
    return row.state === "incomplete" || row.state === "review" || row.state === "correction" || row.state === "ready" || row.setup === "failed";
  }
  return row.state === filter;
}

export const emptyForm: FormInput = {
  name: "", city: "", sector: "", legalName: "", gstin: "", signatory: "", pan: "",
  account: "", ifsc: "",
  documents: {
    pan: { value: "", quality: "clear" },
    gst: { value: "", quality: "clear" },
    bank: { value: "", quality: "clear" },
  },
};

export const sampleForm: FormInput = {
  name: "Monsoon Paperworks",
  city: "Pune",
  sector: "Stationery & retail",
  legalName: "Monsoon Paperworks LLP",
  gstin: "27ZZZCM4826Z9Z7",
  signatory: "Devika Rao",
  pan: "ZZZCM4826Z",
  account: "900000674281",
  ifsc: "DEMO0002781",
  documents: {
    pan: { value: "ZZZCM4826Z", quality: "clear" },
    gst: { value: "Monsoon Paperworks Private Limited", quality: "clear" },
    bank: { value: "900000674281", quality: "clear" },
  },
};
