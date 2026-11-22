import { randomUUID } from "node:crypto";
import type { InboxData, SessionUser } from "./access";
import { database, transaction } from "./db";
import { claimDelivery, deliveryJob, expiredDeliveries, failDelivery, markReceived, queueDelivery, type DeliveryJob, type DeliveryType } from "./delivery";
import {
  checkDetails, checkKinds, filters, intakeLabels, matchesFilter, stateLabels, transitions,
  type Application, type Check, type CheckKind, type Counts, type Evidence, type QueueRow,
  type IntakeItem, type SetupStatus, type State, type StoredInput, type WorkflowMetrics,
} from "./model";
import { verificationRequest } from "./provider";
import { extractionLabels } from "./onboarding";
import { fixtureForm, fixtures } from "./seed";
import { applyCorrection, applyMissing, checkComplete, checkFingerprint, checkIntakeItems, checkKind, fingerprint,
  missingItems, normalizedName, parseSubmission, record, requiredChecks, textField, WorkflowError } from "./validation";

type AppRow = {
  seq: number;
  id: string;
  merchant_account_id: string | null;
  input: string;
  state: State;
  state_at: number;
  updated_at: number;
  correction_kind: CheckKind | "missing" | null;
  correction_reason: string | null;
  correction_items: string | null;
  required_checks: string;
  setup: SetupStatus;
  merchant_id: string | null;
  fail_next: number;
};

type AttemptRow = Omit<Check, "current" | "delivery" | "evidence"> & {
  application_id: string;
  is_current: number;
  fingerprint: string;
  due_at: number | null;
  evidence: string;
  provider_payload: string;
};

type SetupRow = { id: string; application_id: string; status: string; due_at: number; should_fail: number };
type CallbackTarget = "check" | "setup";

const db = database;

function application(id: string) {
  const row = db().prepare("SELECT * FROM applications WHERE id = ?").get(id) as AppRow | undefined;
  if (!row) throw new WorkflowError("This application could not be found.", 404);
  return row;
}

function authorizedApplication(id: string, user: SessionUser) {
  const app = application(id);
  if (user.role === "merchant" && app.merchant_account_id !== user.id) {
    throw new WorkflowError("This application could not be found.", 404);
  }
  return app;
}

function attempts(id: string, currentOnly = true) {
  const clause = currentOnly ? " AND is_current = 1" : "";
  return db().prepare(`SELECT * FROM check_attempts WHERE application_id = ?${clause} ORDER BY rowid DESC`)
    .all(id) as unknown as AttemptRow[];
}

function audit(id: string, title: string, description: string, actor: string, at: number) {
  db().prepare("INSERT INTO activity (application_id, title, description, actor, at) VALUES (?, ?, ?, ?, ?)")
    .run(id, title, description, actor, at);
  db().prepare("UPDATE applications SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(at, id);
}

function markException(id: string, at: number) {
  db().prepare("INSERT INTO application_exceptions (application_id, first_at) VALUES (?, ?) ON CONFLICT DO NOTHING").run(id, at);
}

function mandatory(app: AppRow): CheckKind[] {
  return JSON.parse(app.required_checks);
}

function identity(input: StoredInput) {
  const legal = normalizedName(input.legalName), city = normalizedName(input.city);
  return {
    pan: input.pan.fingerprint,
    gst: input.gstin.fingerprint,
    bank: input.account.fingerprint && input.ifsc.fingerprint ? fingerprint(input.account.fingerprint + input.ifsc.fingerprint) : "",
    legal: legal && city ? legal + ":" + city : "",
  };
}

function identityReasons(left: ReturnType<typeof identity>, right: ReturnType<typeof identity>) {
  const reasons: string[] = [];
  if (left.pan && left.pan === right.pan) reasons.push("Same PAN");
  if (left.gst && left.gst === right.gst) reasons.push("Same GSTIN");
  if (left.bank && left.bank === right.bank) reasons.push("Same account number and IFSC");
  if (left.legal && left.legal === right.legal) reasons.push("Same legal name and city");
  return reasons;
}

function duplicateMatches(app: AppRow, input: StoredInput) {
  const keys = identity(input);
  const candidates = db().prepare(`
    SELECT a.id, a.input, d.signature
    FROM applications a LEFT JOIN duplicate_clearances d ON d.matched_id = a.id AND d.application_id = ?
    WHERE a.id <> ? AND a.state <> 'closed_duplicate' AND (a.seq < ? OR a.state = 'approved')
    ORDER BY a.state = 'approved' DESC, a.seq
  `).all(app.id, app.id, app.seq) as { id: string; input: string; signature: string | null }[];
  return candidates.flatMap(candidate => {
    const other: StoredInput = JSON.parse(candidate.input);
    const otherKeys = identity(other);
    const reasons = identityReasons(keys, otherKeys);
    if (!reasons.length) return [];
    const signature = fingerprint(JSON.stringify([keys, otherKeys]));
    return [{ applicationId: candidate.id, name: other.name, reasons, signature, cleared: signature === candidate.signature }];
  });
}

function refreshRelated(app: AppRow, at: number, previous?: StoredInput) {
  const next = identity(JSON.parse(app.input));
  const before = previous && identity(previous);
  if (before && JSON.stringify(before) === JSON.stringify(next)) return;
  if (before) {
    db().prepare("DELETE FROM duplicate_clearances WHERE application_id = ? OR matched_id = ?").run(app.id, app.id);
    reconcile(app.id, at);
  }
  const candidates = db().prepare(`
    SELECT id, input FROM applications WHERE id <> ? AND state NOT IN ('closed_duplicate', 'approved')
  `).all(app.id) as { id: string; input: string }[];
  for (const candidate of candidates) {
    const keys = identity(JSON.parse(candidate.input));
    if (identityReasons(next, keys).length || (before && identityReasons(before, keys).length)) reconcile(candidate.id, at);
  }
}

function evidenceIssues(input: StoredInput, required: CheckKind[]): Application["evidenceIssues"] {
  const reasons = {
    partial: "Some fields could not be read from the supporting document",
    unreadable: "The supporting document could not be read",
    wrong_document: "The upload appears to be a different type of document",
  };
  return checkKinds.flatMap(kind => {
    const assessment = input.documents[kind].assessment;
    if (!assessment || assessment.status === "complete") return [];
    const missing = assessment.status === "partial" ? assessment.missing.flatMap(field =>
      Object.hasOwn(extractionLabels, field) ? [extractionLabels[field as keyof typeof extractionLabels]] : []) : [];
    const reason = missing.length ? `Missing from the document reading: ${missing.join(", ")}` : reasons[assessment.status];
    return [{ kind, reason, blocking: required.includes(kind) }];
  });
}

function transition(id: string, next: State, at: number) {
  const { state } = application(id);
  if (state === next) return;
  if (!transitions[state].includes(next)) {
    throw new WorkflowError(`This application is ${stateLabels[state].toLowerCase()}. Refresh and try again.`, 409);
  }
  db().prepare("UPDATE applications SET state = ?, state_at = ? WHERE id = ?").run(next, at, id);
  audit(id, "Application state changed", `${stateLabels[state]} → ${stateLabels[next]}`, "Relay workflow", at);
}

function requestCheck(id: string, input: StoredInput, kind: CheckKind, at: number, held = process.env.RELAY_VERIFICATION_MODE === "hold") {
  const { evidence, outcome } = verificationRequest(input, kind);
  db().prepare("UPDATE check_attempts SET is_current = 0 WHERE application_id = ? AND kind = ? AND is_current = 1")
    .run(id, kind);
  const attemptId = randomUUID();
  db().prepare(`
    INSERT INTO check_attempts
      (id, application_id, kind, fingerprint, status, requested_at, updated_at, evidence, provider_payload)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(attemptId, id, kind, checkFingerprint(input, kind), at, at, JSON.stringify(evidence), JSON.stringify(outcome));
  queueDelivery("check", attemptId, id, at + 350, held);
  return attemptId;
}

function create(input: StoredInput, at: number, merchantId: string | null = null, required: CheckKind[] = [...checkKinds]) {
  const missing = missingItems(input, required);
  const row = db().prepare(`
    INSERT INTO applications (input, state, state_at, updated_at, merchant_account_id, required_checks) VALUES (?, ?, ?, ?, ?, ?)
  `).run(JSON.stringify(input), missing.length ? "incomplete" : "verifying", at, at, merchantId, JSON.stringify(required));
  const id = `APP-${String(1040 + Number(row.lastInsertRowid)).padStart(4, "0")}`;
  db().prepare("UPDATE applications SET id = ? WHERE seq = ?").run(id, row.lastInsertRowid);
  audit(id, "Application submitted", missing.length ? "Merchant shared the application for review." : "Business details and supporting documents received.", "Merchant", at);
  const extracted = checkKinds.filter(kind => input.documents[kind].extraction);
  if (extracted.length) {
    const labels = extracted.map(kind => kind === "bank" ? "Bank" : kind.toUpperCase());
    audit(id, "AI document evidence recorded", labels.join(", "), "Onboarding agent", at);
  }
  const queued = checkKinds.filter(kind => checkComplete(input, kind));
  queued.forEach(kind => requestCheck(id, input, kind, at, merchantId === null || process.env.RELAY_VERIFICATION_MODE === "hold"));
  if (queued.length) audit(id, "Verification requested", queued.map(kind => checkDetails[kind].label).join(", "), "Relay workflow", at);
  if (merchantId) {
    reconcile(id, at);
    refreshRelated(application(id), at);
  }
  return id;
}

function reconcile(id: string, at: number) {
  const app = application(id);
  if (app.state === "approved" || app.state === "closed_duplicate") return;
  const input: StoredInput = JSON.parse(app.input);
  const required = mandatory(app);
  const current = attempts(id);
  const missing = missingItems(input, required);
  const needsReview = current.some(check => required.includes(check.kind) && (check.status === "failed" || check.status === "timed_out")) ||
    duplicateMatches(app, input).some(match => !match.cleared) || evidenceIssues(input, required).some(issue => issue.blocking);
  if (missing.length || needsReview) markException(id, at);
  if (app.state === "correction") return;
  transition(id, missing.length ? "incomplete" : needsReview ? "review" : allPassed(app, current) ? "ready" : "verifying", at);
}

function allPassed(app: AppRow, current: AttemptRow[]) {
  const input: StoredInput = JSON.parse(app.input);
  return mandatory(app).every(kind => current.some(check =>
    check.kind === kind && check.status === "passed" && check.fingerprint === checkFingerprint(input, kind),
  ));
}

function receiveCheck(id: string, at: number) {
  const item = db().prepare("SELECT * FROM check_attempts WHERE id = ?").get(id) as AttemptRow | undefined;
  if (!item) throw new WorkflowError("Verification attempt was not found.", 404);
  const eventId = `verification:${id}`;
  const applied = application(item.application_id).state !== "closed_duplicate" &&
    item.is_current === 1 && (item.status === "pending" || item.status === "timed_out");
  if (!saveCallback(eventId, item.application_id, id, "check", applied, at)) return "duplicate";
  markReceived("check", id);

  const provider: ReturnType<typeof verificationRequest>["outcome"] = JSON.parse(item.provider_payload);
  const evidence: Evidence = { ...JSON.parse(item.evidence), provider: provider.provider, reason: provider.reason };
  db().prepare("UPDATE check_attempts SET status = ?, evidence = ?, updated_at = ? WHERE id = ?")
    .run(provider.status, JSON.stringify(evidence), at, id);

  if (applied) {
    audit(item.application_id, `${item.kind === "bank" ? "Bank" : item.kind.toUpperCase()} callback received`, provider.reason,
      checkDetails[item.kind].provider, at);
    reconcile(item.application_id, at);
  } else {
    audit(item.application_id, "Late callback recorded", `${checkDetails[item.kind].label} result belongs to a superseded attempt.`,
      checkDetails[item.kind].provider, at);
  }
  return applied ? "applied" : "superseded";
}

function saveCallback(eventId: string, appId: string, target: string, type: CallbackTarget, applied: boolean, at: number) {
  return db().prepare(`
    INSERT INTO callbacks (id, application_id, target_id, type, received_at, disposition)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING
  `).run(eventId, appId, target, type, at, applied ? "applied" : "superseded").changes === 1;
}

function timeOut(item: AttemptRow, at: number) {
  const evidence = { ...JSON.parse(item.evidence), reason: `${item.kind === "bank" ? "Bank" : item.kind.toUpperCase()} provider timed out` };
  db().prepare("UPDATE check_attempts SET status = 'timed_out', evidence = ?, updated_at = ?, due_at = NULL WHERE id = ?")
    .run(JSON.stringify(evidence), at, item.id);
  audit(item.application_id, "Verification timed out", evidence.reason, "Relay workflow", at);
  reconcile(item.application_id, at);
}

function enqueueSetup(app: AppRow, at: number) {
  const id = randomUUID();
  db().prepare("INSERT INTO setup_attempts (id, application_id, status, due_at, should_fail) VALUES (?, ?, 'pending', ?, ?)")
    .run(id, app.id, at + 650, app.fail_next);
  queueDelivery("setup", id, app.id, at + 650);
  db().prepare("UPDATE applications SET setup = 'pending', fail_next = 0 WHERE id = ?").run(app.id);
  audit(app.id, "Merchant ID setup requested", "Provisioning request queued.", "Relay workflow", at);
  return id;
}

function receiveSetup(id: string, at: number) {
  const item = db().prepare("SELECT * FROM setup_attempts WHERE id = ?").get(id) as SetupRow | undefined;
  if (!item) throw new WorkflowError("Setup attempt was not found.", 404);
  const app = application(item.application_id);
  const applied = item.status === "pending" && app.state === "approved" && app.setup === "pending" && !app.merchant_id;
  if (!saveCallback(`setup:${id}`, item.application_id, id, "setup", applied, at)) return "duplicate";
  markReceived("setup", id);
  if (!applied) return "superseded";

  if (item.should_fail) {
    db().prepare("UPDATE setup_attempts SET status = 'failed' WHERE id = ?").run(id);
    db().prepare("UPDATE applications SET setup = 'failed' WHERE id = ?").run(app.id);
    markException(app.id, at);
    audit(app.id, "Merchant ID setup failed", "The setup simulator returned an error. Retry setup to continue.", "Setup simulator", at);
  } else {
    const merchantId = `MID-RLY-${app.id.slice(4)}`;
    db().prepare("UPDATE setup_attempts SET status = 'active' WHERE id = ?").run(id);
    db().prepare("UPDATE applications SET setup = 'active', merchant_id = ? WHERE id = ?").run(merchantId, app.id);
    audit(app.id, "Merchant ID created", `${merchantId} is active.`, "Setup simulator", at);
  }
  return "applied";
}

function seed() {
  if (db().prepare("SELECT 1 FROM metadata WHERE key = 'fixtures-v1'").get()) return;
  transaction(() => {
    if (db().prepare("SELECT 1 FROM metadata WHERE key = 'fixtures-v1'").get()) return;
    const now = Date.now();
    for (const [index, fixture] of [...fixtures.entries()].reverse()) {
      const at = now - fixture.age * 60_000;
      const id = create(parseSubmission(fixtureForm(fixture, index)), at - 12 * 60_000);
      const pending = attempts(id);
      pending.forEach((item, position) => {
        const checkedAt = at - (2 - position) * 60_000;
        if (fixture.state === "verifying" && item.kind === fixture.case) return;
        if (fixture.case === "timeout" && item.kind === "bank") {
          timeOut(item, checkedAt);
        } else {
          receiveCheck(item.id, checkedAt);
        }
      });

      if (fixture.state === "approved") {
        transition(id, "approved", at);
        audit(id, "Application approved", "All mandatory checks confirmed.", "Ananya Rao", at);
        receiveSetup(enqueueSetup(application(id), at), at + 30_000);
      } else if (fixture.state === "correction") {
        requestCorrection(application(id), "bank", "Please upload a bank document showing the submitted account number.", at);
      } else if (fixture.state === "verifying") {
        db().prepare("UPDATE applications SET state_at = ? WHERE id = ?").run(at - 12 * 60_000, id);
      }
    }
    db().prepare("INSERT INTO metadata (key) VALUES ('fixtures-v1')").run();
  });
}

function toCheck(item: AttemptRow): Check {
  const received = db().prepare("SELECT 1 FROM callbacks WHERE id = ?").get(`verification:${item.id}`);
  const job = deliveryJob("check", item.id);
  return {
    id: item.id,
    kind: item.kind,
    status: item.status,
    requested_at: item.requested_at,
    updated_at: item.updated_at,
    current: item.is_current === 1,
    evidence: JSON.parse(item.evidence),
    delivery: received ? "received" : job?.status === "dead" ? "dead" :
      job?.status === "scheduled" || job?.status === "leased" ? "scheduled" : "held",
  };
}

function toQueueRow(app: AppRow, current: AttemptRow[], merchant = false): QueueRow {
  const input: StoredInput = JSON.parse(app.input);
  const { name, city, sector } = input;
  const required = mandatory(app);
  const missing = missingItems(input, required);
  const issue = current.find(item => required.includes(item.kind) && (item.status === "failed" || item.status === "timed_out"));
  const pending = current.find(item => item.status === "pending");
  const duplicate = !merchant && app.state === "review" && duplicateMatches(app, input).some(match => !match.cleared);
  const extractionIssue = evidenceIssues(input, required).find(item => item.blocking);
  const blockers = {
    incomplete: missing.map(item => intakeLabels[item]).join(", "),
    correction: app.correction_kind === "missing" ? "Awaiting requested information" :
      app.correction_kind ? `Merchant to update ${checkDetails[app.correction_kind].field.toLowerCase()}` : "Awaiting merchant response",
    review: duplicate ? "Possible duplicate application" : issue ? (JSON.parse(issue.evidence) as Evidence).reason :
      extractionIssue ? extractionIssue.reason : "Review verification evidence",
    verifying: pending ? (JSON.parse(pending.evidence) as Evidence).reason : "Verification queued",
    ready: "All mandatory checks passed",
    approved: { idle: "Setup queued", pending: "Creating merchant ID", failed: "Retry merchant ID setup", active: "Merchant ID active" }[app.setup],
    closed_duplicate: "Reviewer closed this application as a duplicate",
  };
  const merchantUpdates = {
    incomplete: "Missing information was shared for review",
    correction: "Review and submit a correction",
    review: "Waiting for the reviewer",
    verifying: "Verification in progress",
    ready: "Waiting for approval",
    approved: app.setup === "active" ? "Merchant ID active" : "Merchant ID setup in progress",
    closed_duplicate: "Your application was closed as a duplicate",
  };
  return {
    id: app.id, name, city, sector, state: app.state, state_at: app.state_at, updated_at: app.updated_at,
    setup: app.setup, blocker: merchant ? merchantUpdates[app.state] : blockers[app.state],
  };
}

function counts(user: SessionUser) {
  const totals: Counts = { all: 0, attention: 0, verifying: 0, approved: 0 };
  const groups = (user.role === "merchant"
    ? db().prepare("SELECT state, setup, COUNT(*) AS total FROM applications WHERE merchant_account_id = ? GROUP BY state, setup").all(user.id)
    : db().prepare("SELECT state, setup, COUNT(*) AS total FROM applications GROUP BY state, setup").all()) as
    { state: State; setup: SetupStatus; total: number }[];
  for (const group of groups) {
    for (const filter of filters) {
      if (matchesFilter(group, filter.key)) totals[filter.key] += group.total;
    }
  }
  return totals;
}

export function listApplications(user: SessionUser) {
  seed();
  const apps = (user.role === "merchant"
    ? db().prepare("SELECT * FROM applications WHERE merchant_account_id = ? ORDER BY updated_at DESC, seq DESC").all(user.id)
    : db().prepare("SELECT * FROM applications ORDER BY updated_at DESC, seq DESC").all()) as unknown as AppRow[];
  return {
    rows: apps.map(app => toQueueRow(app, attempts(app.id), user.role === "merchant")),
    counts: counts(user),
    ...(user.role === "owner" ? { metrics: operationalMetrics() } : {}),
  };
}

function operationalMetrics(): WorkflowMetrics {
  const cohort = db().prepare(`
    SELECT COUNT(*) AS submitted, COUNT(e.application_id) AS exceptions
    FROM activity a LEFT JOIN application_exceptions e ON e.application_id = a.application_id
    WHERE a.title = 'Application submitted' AND a.at >= ?
  `).get(Date.now() - 7 * 24 * 60 * 60 * 1000) as { submitted: number; exceptions: number };
  const dead = db().prepare(`
    SELECT COUNT(*) AS total FROM callback_jobs j JOIN applications a ON a.id = j.application_id
    WHERE j.status = 'dead' AND a.state <> 'closed_duplicate' AND (
      (j.type = 'check' AND EXISTS (SELECT 1 FROM check_attempts c WHERE c.id = j.target_id AND c.is_current = 1))
      OR (j.type = 'setup' AND a.setup = 'failed' AND j.target_id =
        (SELECT s.id FROM setup_attempts s WHERE s.application_id = a.id ORDER BY s.rowid DESC LIMIT 1))
    )
  `).get();
  return { ...cohort, deadLetters: Number(dead?.total) };
}

export function listInbox(user: SessionUser): InboxData {
  if (user.role !== "merchant") throw new WorkflowError("The inbox is available in the merchant workspace.", 403);
  const history = db().prepare(`
    SELECT e.id, e.application_id, e.description, e.at, a.input, a.state,
      ROW_NUMBER() OVER (PARTITION BY a.id ORDER BY e.at DESC, e.id DESC) AS position
    FROM applications a JOIN activity e ON e.application_id = a.id
    WHERE a.merchant_account_id = ? AND e.title = 'Correction requested'
    ORDER BY e.at DESC, e.id DESC
  `).all(user.id) as unknown as {
    id: number; application_id: string; description: string; at: number; input: string; state: State; position: number;
  }[];
  const items = history.map(row => {
    const { name } = JSON.parse(row.input) as StoredInput;
    const separator = row.description.indexOf(" · ");
    return {
      id: row.id, applicationId: row.application_id, applicationName: name,
      field: separator === -1 ? "Supporting evidence" : row.description.slice(0, separator),
      reason: separator === -1 ? row.description : row.description.slice(separator + 3),
      requestedAt: row.at, open: row.state === "correction" && row.position === 1,
    };
  });
  return { items, openCount: items.filter(item => item.open).length };
}

export function loadApplication(id: string, user: SessionUser): Application {
  seed();
  const app = authorizedApplication(id, user);
  const merchant = user.role === "merchant";
  const input: StoredInput = JSON.parse(app.input);
  const history = attempts(id, merchant);
  const checks = history.map(toCheck);
  return {
    ...toQueueRow(app, history.filter(item => item.is_current), merchant),
    submission: {
      name: input.name, city: input.city, sector: input.sector, legalName: input.legalName, signatory: input.signatory,
      gstin: input.gstin.masked, pan: input.pan.masked, account: input.account.masked, ifsc: input.ifsc.masked,
      documents: {
        pan: { value: input.documents.pan.value.masked, quality: input.documents.pan.quality },
        gst: { value: input.documents.gst.value.masked, quality: input.documents.gst.quality },
        bank: { value: input.documents.bank.value.masked, quality: input.documents.bank.quality },
      },
    },
    correction: app.correction_kind ? {
      kind: app.correction_kind, reason: app.correction_reason ?? "",
      items: app.correction_items ? JSON.parse(app.correction_items) as IntakeItem[] : [],
    } : null,
    missing: missingItems(input, mandatory(app)),
    requiredChecks: mandatory(app),
    duplicates: merchant ? [] : duplicateMatches(app, input).map(({ applicationId, name, reasons, cleared }) =>
      ({ applicationId, name, reasons, cleared })),
    evidenceIssues: evidenceIssues(input, mandatory(app)),
    merchant_id: app.merchant_id,
    fail_next: !merchant && app.fail_next === 1,
    checks: checkKinds.flatMap(kind => checks.filter(item => item.kind === kind && item.current)).map(item =>
      merchant ? { ...item, evidence: { ...item.evidence, provider: null } } : item),
    attempts: merchant ? [] : checks,
    activity: merchant ? [] : db().prepare("SELECT id, title, description, actor, at FROM activity WHERE application_id = ? ORDER BY at DESC, id DESC")
      .all(id) as Application["activity"],
    counts: counts(user),
  };
}

export function submit(input: unknown, user: SessionUser) {
  if (user.role !== "merchant") throw new WorkflowError("Sign in as a merchant to submit an application.", 403);
  seed();
  const form = record(input);
  const required = requiredChecks();
  const parsed = parseSubmission(form, required, form.shareIncomplete === true);
  return transaction(() => create(parsed, Date.now(), user.id, required));
}

function requestCorrection(app: AppRow, kind: CheckKind, reason: string, at: number, reviewer = "Ananya Rao") {
  const check = attempts(app.id).find(item => item.kind === kind);
  const flagged = evidenceIssues(JSON.parse(app.input), mandatory(app)).some(issue => issue.kind === kind && issue.blocking);
  if (app.state !== "review" || (check?.status !== "failed" && !flagged)) {
    throw new WorkflowError("Select a failed check that needs corrected evidence.", 409);
  }
  transition(app.id, "correction", at);
  db().prepare("UPDATE applications SET correction_kind = ?, correction_reason = ? WHERE id = ?").run(kind, reason, app.id);
  audit(app.id, "Correction requested", `${checkDetails[kind].field} · ${reason}`, reviewer, at);
}

function requestMissing(app: AppRow, items: IntakeItem[], reason: string, at: number, reviewer: string) {
  const missing = missingItems(JSON.parse(app.input), mandatory(app));
  if (app.state !== "incomplete" || !items.every(item => missing.includes(item))) {
    throw new WorkflowError("Select information that is still missing from this application.", 409);
  }
  transition(app.id, "correction", at);
  db().prepare("UPDATE applications SET correction_kind = 'missing', correction_reason = ?, correction_items = ? WHERE id = ?")
    .run(reason, JSON.stringify(items), app.id);
  audit(app.id, "Correction requested", `${items.map(item => intakeLabels[item]).join(", ")} · ${reason}`, reviewer, at);
}

function finishCorrection(app: AppRow, at: number, revised: StoredInput) {
  transition(app.id, "verifying", at);
  db().prepare("UPDATE applications SET input = ?, correction_kind = NULL, correction_reason = NULL, correction_items = NULL WHERE id = ?")
    .run(JSON.stringify(revised), app.id);
}

function correctMissing(app: AppRow, body: unknown, at: number) {
  if (app.state !== "correction" || app.correction_kind !== "missing" || !app.correction_items) {
    throw new WorkflowError("This application has no open missing information request.", 409);
  }
  const before: StoredInput = JSON.parse(app.input);
  const revised = applyMissing(before, JSON.parse(app.correction_items), body);
  finishCorrection(app, at, revised);
  for (const kind of checkKinds) {
    if (checkComplete(revised, kind) && !checkComplete(before, kind)) requestCheck(app.id, revised, kind, at);
  }
  audit(app.id, "Correction submitted", "Merchant supplied the requested information.", "Merchant", at);
  reconcile(app.id, at);
  refreshRelated(application(app.id), at, before);
}

function correct(app: AppRow, kind: CheckKind, body: unknown, at: number) {
  const requested = app.state === "correction" && app.correction_kind === kind;
  const bankEdit = kind === "bank" && ["verifying", "review", "ready"].includes(app.state);
  if (!requested && !bankEdit) throw new WorkflowError("This field is currently locked.", 409);
  const original: StoredInput = JSON.parse(app.input);
  const revised = applyCorrection(original, kind, body);
  const newCheck = checkFingerprint(original, kind) !== checkFingerprint(revised, kind);
  const changed = newCheck || JSON.stringify(original.documents[kind].assessment) !== JSON.stringify(revised.documents[kind].assessment);
  if (!changed) throw new WorkflowError("Update the field or its supporting evidence before resubmitting.", 409);

  finishCorrection(app, at, revised);
  if (newCheck) requestCheck(app.id, revised, kind, at);
  audit(app.id, requested ? "Correction submitted" : "Bank details updated",
    newCheck ? `${checkDetails[kind].label} restarted. Unchanged checks retained.` : "Evidence updated. Current verification results retained.", "Merchant", at);
  reconcile(app.id, at);
  refreshRelated(application(app.id), at, original);
}

function approve(app: AppRow, at: number, reviewer: string) {
  const input: StoredInput = JSON.parse(app.input);
  const required = mandatory(app);
  if (app.state !== "ready" || missingItems(input, required).length ||
      duplicateMatches(app, input).some(match => !match.cleared) || evidenceIssues(input, required).some(issue => issue.blocking) ||
      !allPassed(app, attempts(app.id))) {
    throw new WorkflowError("Approval requires current passing mandatory checks and resolution of all blocking items.", 409);
  }
  transition(app.id, "approved", at);
  audit(app.id, "Application approved", "All mandatory checks confirmed against the current submission.", reviewer, at);
  enqueueSetup(application(app.id), at);
  refreshRelated(application(app.id), at);
}

function resolveDuplicate(app: AppRow, matchedId: unknown, reason: string, close: boolean, reviewer: string, at: number) {
  const match = duplicateMatches(app, JSON.parse(app.input)).find(item => item.applicationId === matchedId && !item.cleared);
  if (!match || app.state === "approved" || app.state === "closed_duplicate") {
    throw new WorkflowError("This application no longer has that active duplicate match.", 409);
  }
  if (close) {
    transition(app.id, "closed_duplicate", at);
    db().prepare("UPDATE applications SET correction_kind = NULL, correction_reason = NULL, correction_items = NULL WHERE id = ?").run(app.id);
    db().prepare("UPDATE callback_jobs SET status = 'cancelled' WHERE application_id = ? AND status IN ('held', 'scheduled')").run(app.id);
    audit(app.id, "Application closed as duplicate", `${match.applicationId} · ${reason}`, reviewer, at);
    markException(app.id, at);
    refreshRelated(application(app.id), at);
    return;
  }
  db().prepare(`
    INSERT INTO duplicate_clearances (application_id, matched_id, signature)
    VALUES (?, ?, ?) ON CONFLICT (application_id, matched_id) DO UPDATE SET signature = excluded.signature
  `).run(app.id, match.applicationId, match.signature);
  audit(app.id, "Duplicate match cleared", `${match.applicationId} · ${reason}`, reviewer, at);
  reconcile(app.id, at);
}

function retryCheck(app: AppRow, kind: CheckKind, at: number, reviewer: string) {
  const item = attempts(app.id).find(check => check.kind === kind);
  if (!["review", "ready", "incomplete", "approved", "verifying"].includes(app.state) || item?.status !== "timed_out") {
    throw new WorkflowError("Only a timed-out check can be retried here.", 409);
  }
  requestCheck(app.id, JSON.parse(app.input), kind, at);
  audit(app.id, "Verification retried", `${checkDetails[kind].label} queued as a new attempt.`, reviewer, at);
  reconcile(app.id, at);
}

const sensitive = /\b(?:\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]{3}|[A-Z]{5}\d{4}[A-Z]|[A-Z]{4}0[A-Z0-9]{6}|\d{9,18})\b/gi;

function reviewReason(input: unknown) {
  return textField(input, "a reason", 500).replace(sensitive, value => `•••• ${value.slice(-4)}`);
}

export function operate(id: string, payload: unknown, user: SessionUser) {
  seed();
  const fields = record(payload);
  transaction(() => {
    const app = authorizedApplication(id, user);
    const role = fields.action === "correct" || fields.action === "correctMissing" ? "merchant" : "owner";
    if (user.role !== role) throw new WorkflowError("This action is unavailable in your workspace.", 403);
    const at = Date.now();
    switch (fields.action) {
      case "requestCorrection":
        requestCorrection(app, checkKind(fields.kind), reviewReason(fields.reason), at, user.name);
        break;
      case "requestMissing":
        requestMissing(app, checkIntakeItems(fields.items), reviewReason(fields.reason), at, user.name);
        break;
      case "correct":
        correct(app, checkKind(fields.kind), fields.input, at);
        break;
      case "correctMissing":
        correctMissing(app, fields.input, at);
        break;
      case "clearDuplicate":
      case "closeDuplicate":
        resolveDuplicate(app, fields.matchedId, reviewReason(fields.reason), fields.action === "closeDuplicate", user.name, at);
        break;
      case "approve":
        approve(app, at, user.name);
        break;
      case "retryCheck":
        retryCheck(app, checkKind(fields.kind), at, user.name);
        break;
      case "retrySetup":
        if (app.setup !== "failed" || app.state !== "approved" || app.merchant_id) {
          throw new WorkflowError("Setup can only be retried after a failed provisioning attempt.", 409);
        }
        audit(id, "Merchant ID setup retried", "Reviewer requested a new provisioning attempt.", user.name, at);
        enqueueSetup(app, at);
        break;
      default:
        throw new WorkflowError("Choose a supported action.");
    }
  });
  return loadApplication(id, user);
}

export function demo(id: string, payload: unknown, user: SessionUser) {
  if (user.role !== "owner") throw new WorkflowError("Demo controls are available to the owner.", 403);
  seed();
  const fields = record(payload);
  return transaction(() => {
    const app = application(id);
    if (app.state === "closed_duplicate") throw new WorkflowError("This application is closed.", 409);
    const at = Date.now();
    if (fields.action === "failNext") {
      if (app.setup === "active" || app.setup === "pending") {
        throw new WorkflowError("Set a setup failure before approval or retry.", 409);
      }
      db().prepare("UPDATE applications SET fail_next = ? WHERE id = ?").run(app.fail_next ? 0 : 1, id);
      return app.fail_next ? "Next setup will run normally." : "The next setup attempt will fail.";
    }
    if (fields.action === "deliverAll") {
      const changed = db().prepare(`
        UPDATE callback_jobs SET status = 'scheduled', available_at = ? WHERE application_id = ? AND type = 'check'
          AND status = 'held' AND target_id IN (SELECT id FROM check_attempts WHERE is_current = 1 AND status = 'pending')
      `).run(at + 350, id).changes;
      if (!changed) throw new WorkflowError("There are no pending callbacks to deliver.", 409);
      return "Pending callbacks scheduled.";
    }
    if (fields.action === "replaySetup") {
      const attempt = db().prepare("SELECT id FROM setup_attempts WHERE application_id = ? AND status = 'active'").get(id);
      if (!attempt) throw new WorkflowError("Complete merchant ID setup first.", 409);
      receiveSetup(String(attempt.id), at);
      return "Duplicate setup callback ignored.";
    }

    const item = attempts(id, false).find(attempt => attempt.id === fields.attempt);
    if (!item) throw new WorkflowError("Choose a verification attempt.", 404);
    const received = db().prepare("SELECT 1 FROM callbacks WHERE id = ?").get(`verification:${item.id}`);
    const job = deliveryJob("check", item.id);
    if (fields.action === "deliver" && !received && job?.status === "held") {
      db().prepare("UPDATE callback_jobs SET status = 'scheduled', available_at = ? WHERE type = 'check' AND target_id = ?")
        .run(at + 350, item.id);
      return "Callback scheduled.";
    }
    if (fields.action === "failDelivery" && !received && job && (job.status === "held" || job.status === "scheduled")) {
      db().prepare("UPDATE callback_jobs SET status = 'scheduled', forced_failures = 4, available_at = ? WHERE type = 'check' AND target_id = ?")
        .run(at + 350, item.id);
      return "Callback transport failure scheduled. Relay will retry before moving it to dead letters.";
    }
    if (fields.action === "replay" && received) {
      receiveCheck(item.id, at);
      return "Duplicate verification callback ignored.";
    }
    if (fields.action === "timeout" && item.is_current && item.status === "pending" && job &&
        (job.status === "scheduled" || job.status === "held")) {
      db().prepare("UPDATE callback_jobs SET status = 'held', available_at = NULL WHERE type = 'check' AND target_id = ?")
        .run(item.id);
      timeOut(item, at);
      return "Provider timeout recorded.";
    }
    throw new WorkflowError("This action is unavailable for the selected attempt.", 409);
  });
}

function handleDeliveryFailure(job: DeliveryJob, at: number, retryable: boolean) {
  const dead = failDelivery(job, at, retryable);
  const target = job.type === "check"
    ? db().prepare("SELECT * FROM check_attempts WHERE id = ?").get(job.target_id) as AttemptRow | undefined
    : undefined;
  const label = target ? checkDetails[target.kind].label : "Merchant ID setup";
  audit(job.application_id, dead ? "Callback moved to dead letters" : "Callback delivery retry scheduled",
    `${label} · Delivery ${job.delivery_count} of 4 failed.`, "Relay dispatcher", at);
  if (!dead) return;
  const app = application(job.application_id);
  if (app.state === "closed_duplicate") return;
  if (job.type === "check" && target?.is_current && target.status === "pending") timeOut(target, at);
  if (job.type === "setup" && app.setup === "pending") {
    const update = db().prepare("UPDATE setup_attempts SET status = 'failed' WHERE id = ? AND status = 'pending'").run(job.target_id);
    if (update.changes) {
      db().prepare("UPDATE applications SET setup = 'failed' WHERE id = ?").run(app.id);
      markException(app.id, at);
    }
  }
}

export function claimCallback() {
  return transaction(() => {
    const at = Date.now();
    for (const job of expiredDeliveries(at)) handleDeliveryFailure(job, at, true);
    return claimDelivery(at);
  });
}

export function callback(payload: unknown) {
  const { action, type, id, lease, retryable } = record(payload);
  if ((type !== "check" && type !== "setup") || typeof id !== "string" || typeof lease !== "string" ||
      (action !== "deliver" && action !== "fail")) {
    throw new WorkflowError("Callback target is invalid.");
  }
  return transaction(() => {
    const job = deliveryJob(type as DeliveryType, id);
    if (!job) throw new WorkflowError("Callback job was not found.", 404);
    if (job.status === "received") return "duplicate";
    const at = Date.now();
    if (job.status !== "leased" || job.lease_id !== lease || (job.lease_until ?? 0) <= at) return "stale";
    if (action === "fail") {
      handleDeliveryFailure(job, at, retryable === true);
      return "recorded";
    }
    if (job.forced_failures > 0) {
      db().prepare("UPDATE callback_jobs SET forced_failures = forced_failures - 1 WHERE type = ? AND target_id = ?").run(type, id);
      return "transport_failure";
    }
    return type === "check" ? receiveCheck(id, at) : receiveSetup(id, at);
  });
}
