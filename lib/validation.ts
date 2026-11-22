import { createHash } from "node:crypto";
import { checkKinds, intakeLabels, type CheckKind, type IntakeItem, type StoredInput } from "./model";
import { extractionAssessment, extractionSource } from "./extraction-receipt";

export class WorkflowError extends Error {
  constructor(message: string, public status = 400, public readonly retryAfterSeconds?: number) {
    super(message);
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkflowError("Enter the requested fields and try again.");
  }
  return value as Record<string, unknown>;
}

export function textField(value: unknown, label: string, limit = 120): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > limit) {
    throw new WorkflowError(`Enter ${label} using 1–${limit} characters.`);
  }
  return value.trim().replace(/\s+/g, " ");
}

export function checkKind(value: unknown): CheckKind {
  if (!(checkKinds as readonly unknown[]).includes(value)) throw new WorkflowError("Choose a verification check.");
  return value as CheckKind;
}

const patterns = {
  pan: /^[A-Z]{5}\d{4}[A-Z]$/,
  gstin: /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3}$/,
  account: /^\d{9,18}$/,
  ifsc: /^[A-Z]{4}0[A-Z0-9]{6}$/,
};

const labels = {
  pan: "PAN", gstin: "GSTIN", account: "bank account number", ifsc: "IFSC",
};

export function identifier(value: unknown, kind: keyof typeof patterns) {
  const normalized = textField(value, labels[kind], 18).toUpperCase().replace(/\s/g, "");
  if (!patterns[kind].test(normalized)) {
    throw new WorkflowError(`Enter a valid fictional ${labels[kind]}.`);
  }
  return { masked: `•••• ${normalized.slice(-4)}`, fingerprint: fingerprint(normalized) };
}

export function fingerprint(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizedName(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

const emptyValue = { masked: "", fingerprint: "" };

function blank(value: unknown) {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

export function documentPayload(input: unknown, kind: CheckKind, allowEmpty = false): StoredInput["documents"][CheckKind] {
  const doc = record(input);
  if (doc.quality !== "clear" && doc.quality !== "blurred") {
    throw new WorkflowError("Choose the quality of the supporting document.");
  }
  const value = allowEmpty && blank(doc.value) ? emptyValue : kind === "gst"
    ? gstName(doc.value)
    : identifier(doc.value, kind === "pan" ? "pan" : "account");
  const extraction = extractionSource(doc.receipt, kind, value.fingerprint, doc.quality);
  return { value, quality: doc.quality, extraction, assessment: extractionAssessment(doc.assessmentReceipt, kind) };
}

function gstName(value: unknown) {
  const name = textField(value, "the legal name on the GST certificate");
  return { masked: name, fingerprint: fingerprint(normalizedName(name)) };
}

const prerequisites: Record<CheckKind, IntakeItem[]> = {
  pan: ["signatory", "pan", "documents.pan"],
  gst: ["legalName", "gstin", "documents.gst"],
  bank: ["account", "ifsc", "documents.bank"],
};

function hasItem(input: StoredInput, item: IntakeItem) {
  if (item === "documents.pan" || item === "documents.gst" || item === "documents.bank") {
    return Boolean(input.documents[item.slice(10) as CheckKind].value.fingerprint);
  }
  const value = input[item];
  return typeof value === "string" ? Boolean(value) : Boolean(value.fingerprint);
}

export function missingItems(input: StoredInput, required: readonly CheckKind[]): IntakeItem[] {
  const items: IntakeItem[] = ["name", "city", "sector", "legalName", ...required.flatMap(kind => prerequisites[kind])];
  return [...new Set(items)].filter(item => !hasItem(input, item));
}

export function checkComplete(input: StoredInput, kind: CheckKind) {
  return prerequisites[kind].every(item => hasItem(input, item));
}

export function requiredChecks(): CheckKind[] {
  return process.env.RELAY_REQUIRE_GST === "false" ? ["pan", "bank"] : [...checkKinds];
}

export function parseSubmission(input: unknown, required: readonly CheckKind[] = checkKinds, shareIncomplete = false): StoredInput {
  const fields = record(input);
  const docs = fields.documents === undefined ? {} : record(fields.documents);
  const doc = (kind: CheckKind) => documentPayload(docs[kind] ?? { value: "", quality: "clear" }, kind, true);
  const text = (key: "city" | "sector" | "legalName" | "signatory", limit?: number) =>
    blank(fields[key]) ? "" : textField(fields[key], intakeLabels[key].toLowerCase(), limit);
  const id = (kind: keyof typeof patterns) => blank(fields[kind]) ? emptyValue : identifier(fields[kind], kind);
  const documents = {
    pan: doc("pan"), gst: doc("gst"), bank: doc("bank"),
  };
  const parsed: StoredInput = {
    name: textField(fields.name, "the merchant name"),
    city: text("city", 60), sector: text("sector", 60), legalName: text("legalName"), signatory: text("signatory"),
    gstin: id("gstin"), pan: id("pan"), account: id("account"), ifsc: id("ifsc"),
    documents,
  };
  const missing = missingItems(parsed, required);
  if (!shareIncomplete && missing.length) throw new WorkflowError(`Provide ${missing.map(item => intakeLabels[item]).join(", ")} or choose Send for review.`);
  return parsed;
}

export function checkIntakeItems(value: unknown): IntakeItem[] {
  if (!Array.isArray(value) || !value.length || value.length > Object.keys(intakeLabels).length ||
      !value.every(item => typeof item === "string" && Object.hasOwn(intakeLabels, item))) {
    throw new WorkflowError("Select the required information to request.");
  }
  return [...new Set(value)] as IntakeItem[];
}

export function applyMissing(current: StoredInput, items: IntakeItem[], input: unknown): StoredInput {
  const fields = record(input);
  const next = { ...current, documents: { ...current.documents } };
  for (const item of items) {
    if (item === "documents.pan" || item === "documents.gst" || item === "documents.bank") {
      const kind = item.slice(10) as CheckKind;
      next.documents[kind] = documentPayload(fields[item], kind);
    } else if (item === "pan" || item === "gstin" || item === "account" || item === "ifsc") {
      next[item] = identifier(fields[item], item);
    } else {
      next[item] = textField(fields[item], intakeLabels[item], item === "city" || item === "sector" ? 60 : 120);
    }
  }
  return next;
}

export function applyCorrection(current: StoredInput, kind: CheckKind, input: unknown): StoredInput {
  const fields = record(input);
  const next = { ...current, documents: { ...current.documents } };
  if (kind === "gst") {
    next.legalName = textField(fields.legalName, "the registered legal name");
    if (fields.gstin) next.gstin = identifier(fields.gstin, "gstin");
  } else if (kind === "pan") {
    if (fields.pan) next.pan = identifier(fields.pan, "pan");
  } else {
    if (fields.account) next.account = identifier(fields.account, "account");
    if (fields.ifsc) next.ifsc = identifier(fields.ifsc, "ifsc");
  }
  const doc = record(fields.document);
  if (doc.quality !== "clear" && doc.quality !== "blurred") {
    throw new WorkflowError("Choose the quality of the supporting document.");
  }
  const previous = current.documents[kind];
  const replacement: StoredInput["documents"][CheckKind] = doc.value || kind === "gst"
    ? documentPayload(doc, kind)
    : { value: previous.value, quality: doc.quality, assessment: extractionAssessment(doc.assessmentReceipt, kind) };
  if (replacement.value.fingerprint === previous.value.fingerprint && replacement.quality === previous.quality) {
    replacement.extraction ??= previous.extraction;
  }
  if (doc.confirmManual !== true) replacement.assessment ??= previous.assessment;
  next.documents[kind] = replacement;
  return next;
}

export function checkFingerprint(input: StoredInput, kind: CheckKind) {
  const document = input.documents[kind];
  const fields = {
    pan: [input.pan.fingerprint],
    gst: [input.gstin.fingerprint, normalizedName(input.legalName)],
    bank: [input.account.fingerprint, input.ifsc.fingerprint],
  };
  return fingerprint(JSON.stringify([...fields[kind], document.value.fingerprint, document.quality]));
}

