import { checkDetails, sampleForm, type CheckKind, type Evidence, type StoredInput } from "./model";
import { fingerprint, normalizedName } from "./validation";

type Outcome = { status: "passed" | "failed"; provider: string; reason: string };

const registry = new Map([
  [fingerprint(sampleForm.gstin), sampleForm.documents.gst.value],
  [fingerprint("27ZZZCS2944Z9Z8"), "Saffron & Sage Hospitality Private Limited"],
]);

export function verificationRequest(input: StoredInput, kind: CheckKind): { evidence: Evidence; outcome: Outcome } {
  const doc = input.documents[kind];
  const submitted = kind === "gst" ? input.legalName : kind === "pan" ? input.pan.masked : input.account.masked;
  const provider = kind === "gst" ? (registry.get(input.gstin.fingerprint) ?? doc.value.masked) : submitted;
  const matches = kind === "gst"
    ? normalizedName(submitted) === normalizedName(doc.value.masked)
    : doc.value.fingerprint === (kind === "pan" ? input.pan.fingerprint : input.account.fingerprint);
  const evidence: Evidence = {
    submitted,
    extracted: doc.value.masked,
    provider: null,
    confidence: doc.extraction ? null : doc.quality === "blurred" ? 48 : 98,
    extraction: doc.extraction,
    reason: `Awaiting ${kind === "bank" ? "bank" : kind.toUpperCase()} callback`,
  };

  if (doc.quality === "blurred") {
    return { evidence, outcome: { status: "failed", provider, reason: `${checkDetails[kind].field} document is too blurred to verify` } };
  }
  if (kind === "gst" && normalizedName(submitted) !== normalizedName(provider)) {
    return { evidence, outcome: { status: "failed", provider, reason: "GST legal name differs from application" } };
  }
  if (!matches) {
    return { evidence, outcome: { status: "failed", provider, reason: `${checkDetails[kind].field} differs from supporting document` } };
  }
  return { evidence, outcome: { status: "passed", provider, reason: `${checkDetails[kind].field} confirmed` } };
}
