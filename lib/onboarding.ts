import type { CheckKind } from "./model";

export const extractionGuides = {
  pan: { title: "PAN card", fields: ["pan", "signatory"], primary: "pan", hint: "PAN and the cardholder’s full name" },
  gst: { title: "GST certificate", fields: ["gstin", "legalName", "city"], primary: "legalName", hint: "GSTIN, legal business name and city" },
  bank: { title: "Bank proof", fields: ["account", "ifsc"], primary: "account", hint: "Account number and IFSC" },
} as const;

export type ExtractionField = (typeof extractionGuides)[CheckKind]["fields"][number];
export type Readability = "readable" | "unreadable" | "wrong_document";

export const extractionLabels: Record<ExtractionField, string> = {
  pan: "PAN", signatory: "Signatory name", gstin: "GSTIN", legalName: "Legal name", city: "City",
  account: "Account number", ifsc: "IFSC",
};

export const sensitiveFields: readonly ExtractionField[] = ["pan", "gstin", "account", "ifsc"];
export const maxDocumentBytes = 8 * 1024 * 1024;
export const maxPageBytes = 3 * 1024 * 1024;
export const maxPages = 2;

export type ExtractionProvider = "ollama" | "openrouter";
export type ExtractionStatus = {
  enabled: boolean;
  provider: ExtractionProvider;
  mode: "cloud" | "local";
  model: string;
};

export function extractionProviderLabel(status: ExtractionStatus) {
  if (status.provider === "openrouter") return "OpenRouter Free";
  return status.mode === "local" ? "Local Ollama" : "Ollama Cloud";
}

export type ExtractedDocument = {
  kind: CheckKind;
  readability: Readability;
  values: Partial<Record<ExtractionField, string>>;
  model: string;
  receipt?: string;
  assessmentReceipt?: string;
};
