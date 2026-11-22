import { createHmac, timingSafeEqual } from "node:crypto";
import type { CheckKind, DocumentInput, ExtractionAssessment, ExtractionSource } from "./model";

function receiptSecret(source: ExtractionSource["source"]) {
  const providerKey = source === "openrouter" ? process.env.OPENROUTER_API_KEY : process.env.OLLAMA_API_KEY;
  return process.env.RELAY_EXTRACTION_SECRET?.trim() || providerKey?.trim() || process.env.RELAY_PROVIDER_TOKEN;
}

function signature(source: ExtractionSource["source"], model: string, kind: CheckKind, fingerprint: string, quality: DocumentInput["quality"]) {
  const secret = receiptSecret(source);
  if (!secret) return;
  return createHmac("sha256", secret)
    .update(JSON.stringify([source === "openrouter" ? "relay-extraction-openrouter-v1" : "relay-extraction-v1", model, kind, fingerprint, quality]))
    .digest();
}

export function signAssessment(source: ExtractionSource["source"], kind: CheckKind, assessment: ExtractionAssessment) {
  const secret = receiptSecret(source);
  if (!secret) return;
  const payload = Buffer.from(JSON.stringify(assessment)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`assessment-v1:${source}:${kind}:${payload}`).digest("base64url");
  return `${source}.${payload}.${signature}`;
}

export function extractionAssessment(receipt: unknown, kind: CheckKind): ExtractionAssessment | undefined {
  if (typeof receipt !== "string" || receipt.length > 600) return;
  const [source, payload, proof, extra] = receipt.split(".");
  if ((source !== "ollama" && source !== "openrouter") || !payload || !proof || extra !== undefined) return;
  const secret = receiptSecret(source);
  if (!secret) return;
  const expected = createHmac("sha256", secret).update(`assessment-v1:${source}:${kind}:${payload}`).digest();
  const received = Buffer.from(proof, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return;
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ExtractionAssessment;
}

export function signExtraction(source: ExtractionSource["source"], model: string, kind: CheckKind, fingerprint: string) {
  const signed = signature(source, model, kind, fingerprint, "clear");
  if (signed) return `${source === "openrouter" ? "openrouter|" : ""}${model}|${signed.toString("base64url")}`;
}

export function extractionSource(receipt: unknown, kind: CheckKind, fingerprint: string, quality: DocumentInput["quality"]): ExtractionSource | undefined {
  if (typeof receipt !== "string" || receipt.length > 180) return;
  const parts = receipt.split("|");
  const isOpenRouter = parts.length === 3 && parts[0] === "openrouter";
  const source = isOpenRouter ? "openrouter" : "ollama";
  const [model, proof, extra] = isOpenRouter ? parts.slice(1) : parts;
  if (!model || !proof || extra !== undefined || !/^[a-zA-Z0-9_./:-]{1,120}$/.test(model)) return;
  const expected = signature(source, model, kind, fingerprint, quality);
  const received = Buffer.from(proof, "base64url");
  if (expected && received.length === expected.length && timingSafeEqual(received, expected)) {
    return { source, model };
  }
}
