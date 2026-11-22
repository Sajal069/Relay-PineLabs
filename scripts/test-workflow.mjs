import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const dir = await mkdtemp(join(tmpdir(), "relay-workflow-test-"));
const password = "Verification-test-only-8042";
const ownerId = "verification-test-owner";
const api = "/api/relay";
const children = new Set();

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function until(label, read, seconds = 10) {
  const deadline = Date.now() + seconds * 1000;
  do {
    const value = await read();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${label}.`);
}

async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise(resolve => child.once("exit", resolve));
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else child.kill();
    await stopped;
  }
  children.delete(child);
}

async function start(database, overrides = {}, dispatcher = true) {
  const socket = createServer();
  const port = await listen(socket);
  await new Promise(resolve => socket.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath,
    [dispatcher ? "scripts/run.mjs" : "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, RELAY_DB_PATH: database, RELAY_OWNER_ID: ownerId, RELAY_OWNER_PASSWORD: password,
        RELAY_VERIFICATION_MODE: "auto", RELAY_REQUIRE_GST: "true", RELAY_EXTRACTION_SECRET: "test-extraction-receipt",
        ...overrides,
      },
    });
  children.add(child);
  let log = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", part => { log = (log + part).slice(-4000); });
  try {
    await until("Relay readiness", async () => {
      if (child.exitCode !== null) throw new Error("Relay exited during startup.");
      try { return (await fetch(origin, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, 25);
  } catch (error) {
    throw new Error(log || "Relay never started.", { cause: error });
  }
  return { child, origin };
}

async function request(server, path, { cookie, body, status = 200, headers = {} } = {}) {
  const json = body !== undefined && !(body instanceof FormData);
  const response = await fetch(server.origin + path, {
    method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(8000),
    headers: { origin: server.origin, ...(cookie && { cookie }), ...(json && { "content-type": "application/json" }), ...headers },
    body: json ? JSON.stringify(body) : body,
  });
  const data = await response.json().catch(() => null);
  assert.equal(response.status, status, `${path} ${data?.error ?? ""}`);
  return { data, cookie: response.headers.get("set-cookie")?.split(";")[0] };
}

async function login(server, action, fields, status = 200) {
  const result = await request(server, `${api}/session`, { body: { action, password, ...fields }, status });
  assert.ok(result.cookie);
  return result.cookie;
}

function synthetic(number, name) {
  const suffix = String(number).padStart(4, "0");
  const pan = `ZZZCT${suffix}Z`;
  const account = `95555000${suffix}`;
  return {
    name, legalName: `${name} Private Limited`, city: "Pune", sector: "Stationery & retail", signatory: "Fictional Applicant",
    gstin: `27${pan}9Z7`, pan, account, ifsc: "DEMO0002781",
    documents: { pan: { value: pan, quality: "clear" }, gst: { value: `${name} Private Limited`, quality: "clear" },
      bank: { value: account, quality: "clear" } },
  };
}

function actions(server, merchant, owner) {
  return {
    send: async (body, status = 201) => (await request(server, api, { cookie: merchant, body, status })).data,
    read: async (id, cookie = owner, status = 200) => (await request(server, `${api}/${id}`, { cookie, status })).data,
    operation: async (id, body, cookie = owner, status = 200) =>
      (await request(server, `${api}/${id}`, { cookie, body, status })).data,
    demo: async (id, body) => (await request(server, `${api}/${id}/demo`, { cookie: owner, body })).data,
  };
}

const stub = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks));
  if (input.messages?.[1]?.images?.length !== 2) return res.writeHead(400).end();
  res.setHeader("content-type", "application/json");
  const content = JSON.stringify({ readability: "readable", fields: { pan: synthetic(102, "Image Intake").pan } });
  res.end(JSON.stringify({ message: { content } }));
});

try {
  const stubPort = await listen(stub);
  const mode = { EXTRACTION_PROVIDER: "ollama", OLLAMA_MODE: "local", OLLAMA_MODEL: "test-vision",
    OLLAMA_LOCAL_URL: `http://127.0.0.1:${stubPort}` };
  const database = join(dir, "automatic.sqlite");
  const server = await start(database, mode);
  const merchant = await login(server, "signUp", { name: "Test Merchant", email: "test@example.test" }, 201);
  const other = await login(server, "signUp", { name: "Other Test Merchant", email: "other@example.test" }, 201);
  const owner = await login(server, "signIn", { role: "owner", id: ownerId });
  const a = actions(server, merchant, owner);
  await request(server, "/api/provider", { body: { action: "claim" }, status: 401 });

  const first = synthetic(101, "Incomplete Intake");
  const { account, ...partial } = first;
  await a.send(partial, 400);
  const { id } = await a.send({ ...partial, shareIncomplete: true });
  assert.equal((await a.read(id)).state, "incomplete");
  assert.deepEqual((await a.read(id)).missing, ["account"]);
  await a.read(id, other, 404);
  await a.operation(id, { action: "approve" }, owner, 409);
  await a.operation(id, { action: "requestMissing", items: ["account"], reason: "Please add your account number." });
  const inbox = (await request(server, `${api}/inbox`, { cookie: merchant })).data;
  assert.equal(inbox.openCount, 1);
  assert.equal(inbox.items[0].applicationId, id);
  const preserved = (await a.read(id)).checks.find(check => check.kind === "pan").id;
  await a.operation(id, { action: "correctMissing", input: { account } }, merchant);
  const ready = await until("automatic readiness", async () => {
    const app = await a.read(id);
    return app.state === "ready" && app;
  });
  assert.equal(ready.checks.find(check => check.kind === "pan").id, preserved);
  assert.equal(ready.merchant_id, null);
  await a.operation(id, { action: "approve" }, merchant, 403);
  await a.demo(id, { action: "failNext" });
  await a.operation(id, { action: "approve" });
  await until("setup failure", async () => (await a.read(id)).setup === "failed");
  await a.operation(id, { action: "retrySetup" });
  const mid = await until("merchant ID", async () => (await a.read(id)).merchant_id);
  await a.demo(id, { action: "replaySetup" });
  assert.equal((await a.read(id)).merchant_id, mid);
  assert.equal((await a.read(id)).activity.filter(event => event.title === "Merchant ID created").length, 1);

  const second = (await a.send(first)).id;
  assert.equal((await a.read(second)).state, "review");
  assert.ok((await a.read(second)).duplicates.some(match => match.applicationId === id && match.reasons.includes("Same PAN")));
  assert.deepEqual((await a.read(second, merchant)).duplicates, []);
  await a.operation(second, { action: "approve" }, owner, 409);
  await a.operation(second, { action: "clearDuplicate", matchedId: id, reason: "Reviewed legitimate repeat." });
  await until("cleared case readiness", async () => (await a.read(second)).state === "ready");
  const bankBefore = (await a.read(second)).checks.find(check => check.kind === "bank").id;
  await a.operation(second, { action: "correct", kind: "bank", input: {
    account: "955550007431", document: { value: "955550007431", quality: "clear" },
  } }, merchant);
  assert.equal((await a.read(second)).state, "review");
  assert.notEqual((await a.read(second)).checks.find(check => check.kind === "bank").id, bankBefore);
  assert.equal((await a.read(second)).duplicates.find(match => match.applicationId === id).cleared, false);
  await a.operation(second, { action: "closeDuplicate", matchedId: id, reason: "Already onboarded." });
  assert.equal((await a.read(second, merchant)).state, "closed_duplicate");
  await a.operation(second, { action: "approve" }, owner, 409);
  console.log("Passed missing information, automatic verification, role isolation, provisioning retry, duplicate holds and bank re-verification.");

  const low = synthetic(102, "Image Intake");
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1sAAAAASUVORK5CYII=", "base64");
  const body = new FormData();
  body.append("kind", "pan");
  for (const page of [1, 2]) body.append("pages", new Blob([image], { type: "image/png" }), `page-${page}.png`);
  const extraction = (await request(server, "/api/extract", { cookie: merchant, body, headers: { "x-relay-extraction": "1" } })).data;
  assert.ok(extraction.assessmentReceipt);
  const lowId = (await a.send({ ...low, documents: {
    ...low.documents, pan: { ...low.documents.pan, assessmentReceipt: extraction.assessmentReceipt, receipt: extraction.receipt },
  } })).id;
  await until("verification with incomplete AI evidence", async () => (await a.read(lowId)).checks.every(check => check.status === "passed"));
  assert.match((await a.read(lowId)).evidenceIssues[0].reason, /Signatory name/);
  await a.operation(lowId, { action: "approve" }, owner, 409);
  await a.operation(lowId, { action: "requestCorrection", kind: "pan", reason: "Please provide a clear PAN document." });
  await a.operation(lowId, { action: "correct", kind: "pan", input: {
    document: { ...low.documents.pan, confirmManual: true },
  } }, merchant);
  assert.equal((await a.read(lowId)).state, "ready");
  const queue = (await request(server, api, { cookie: owner })).data;
  assert.ok(queue.metrics.exceptions >= 3 && queue.metrics.submitted >= queue.metrics.exceptions);
  assert.equal((await request(server, api, { cookie: merchant })).data.metrics, undefined);
  await stop(server.child);
  console.log("Passed signed two-page extraction evidence, low-confidence hold and recovery, and owner metrics.");

  const heldDatabase = join(dir, "held.sqlite");
  const heldMode = { RELAY_VERIFICATION_MODE: "hold", RELAY_REQUIRE_GST: "false" };
  const leaseToken = "workflow-test-lease-token";
  const original = await start(heldDatabase, { ...heldMode, RELAY_PROVIDER_TOKEN: leaseToken }, false);
  const heldMerchant = await login(original, "signUp", { name: "Hold Merchant", email: "held@example.test" }, 201);
  const heldOwner = await login(original, "signIn", { role: "owner", id: ownerId });
  const initial = actions(original, heldMerchant, heldOwner);
  const heldForm = synthetic(103, "Held Transport");
  heldForm.gstin = "";
  delete heldForm.documents.gst;
  const heldId = (await initial.send(heldForm)).id;
  const held = await initial.read(heldId);
  assert.deepEqual(held.requiredChecks, ["pan", "bank"]);
  assert.ok(held.checks.every(check => check.delivery === "held"));
  const heldPan = held.checks.find(check => check.kind === "pan").id;
  const originalBank = held.checks.find(check => check.kind === "bank").id;
  await initial.demo(heldId, { action: "timeout", attempt: originalBank });
  await initial.operation(heldId, { action: "retryCheck", kind: "bank" });
  await initial.demo(heldId, { action: "failDelivery", attempt: heldPan });
  const claimed = await until("callback lease", async () => (await request(original, "/api/provider", {
    body: { action: "claim" }, headers: { authorization: `Bearer ${leaseToken}` },
  })).data.job);
  assert.equal(claimed.id, heldPan);
  await stop(original.child);
  const testDb = new DatabaseSync(heldDatabase);
  testDb.prepare("UPDATE callback_jobs SET lease_until = ? WHERE target_id = ?").run(Date.now() - 1, heldPan);
  testDb.close();

  const resumed = await start(heldDatabase, { RELAY_VERIFICATION_MODE: "hold" });
  const b = actions(resumed, heldMerchant, heldOwner);
  assert.deepEqual((await b.read(heldId)).requiredChecks, ["pan", "bank"]);
  await b.demo(heldId, { action: "deliver", attempt: originalBank });
  await until("superseded bank callback", async () => (await b.read(heldId)).activity.some(event => event.title === "Late callback recorded"));
  assert.equal((await b.read(heldId)).checks.find(check => check.kind === "bank").status, "pending");
  await b.demo(heldId, { action: "deliverAll" });
  const exhausted = await until("dead-letter delivery exhaustion", async () => {
    const app = await b.read(heldId);
    return app.checks.some(check => check.delivery === "dead") && app;
  }, 35);
  assert.equal(exhausted.state, "review");
  assert.equal(exhausted.activity.filter(event => event.title === "Callback delivery retry scheduled").length, 3);
  assert.equal((await request(resumed, api, { cookie: heldOwner })).data.metrics.deadLetters, 1);
  await b.operation(heldId, { action: "retryCheck", kind: "pan" });
  await b.demo(heldId, { action: "deliverAll" });
  await until("dead-letter recovery", async () => (await b.read(heldId)).state === "ready");
  assert.equal((await request(resumed, api, { cookie: heldOwner })).data.metrics.deadLetters, 0);
  console.log("Passed hold mode, optional GST, lease recovery after restart, late callbacks, retry exhaustion, and dead-letter recovery.");
} finally {
  await Promise.all([...children].map(stop));
  await new Promise(resolve => stub.close(resolve));
  for (const name of ["automatic.sqlite", "held.sqlite"]) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) await rm(join(dir, name + suffix), { force: true });
  }
  await rmdir(dir);
}
