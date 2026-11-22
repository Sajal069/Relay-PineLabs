import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { database, transaction } from "./db";
import type { SessionUser } from "./access";
import { fingerprint, record, textField, WorkflowError } from "./validation";

export const sessionCookie = "relay_session";
const durationSeconds = 8 * 60 * 60;
const authWindowMs = 10 * 60 * 1000;
const cookieToken = /^[A-Za-z0-9_-]{43}$/;

type AccountRow = { id: string; name: string; password_hash: string };
type SessionRow = { merchant_account_id: string | null; owner_version: string | null; name: string | null };

function ownerConfig() {
  const id = process.env.RELAY_OWNER_ID?.trim().toLowerCase();
  const password = process.env.RELAY_OWNER_PASSWORD;
  if (!id || id.length > 254 || !validPassword(password)) return null;
  return { id, password, version: fingerprint(JSON.stringify([id, password, "relay-owner-v1"])) };
}

function constantEqual(a: string, b: string) {
  return timingSafeEqual(Buffer.from(fingerprint(a), "hex"), Buffer.from(fingerprint(b), "hex"));
}

function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function emailAddress(value: unknown) {
  const email = textField(value, "an email address", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
    throw new WorkflowError("Enter a valid email address.");
  }
  return email;
}

function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 128 && Boolean(value.trim());
}

function countAttempt(scope: string, limit: number) {
  const at = Date.now();
  const db = database();
  db.prepare("DELETE FROM auth_limits WHERE reset_at <= ?").run(at);
  const bucket = db.prepare(`
    INSERT INTO auth_limits (scope, attempts, reset_at) VALUES (?, 1, ?)
    ON CONFLICT(scope) DO UPDATE SET attempts = attempts + 1
    RETURNING attempts, reset_at
  `).get(scope, at + authWindowMs) as { attempts: number; reset_at: number };
  if (bucket.attempts > limit) {
    throw new WorkflowError("Too many attempts. Wait a few minutes before trying again.", 429,
      Math.max(1, Math.ceil((bucket.reset_at - at) / 1000)));
  }
}

function issueSession(user: SessionUser, version: string | null, previousToken?: string) {
  const token = randomBytes(32).toString("base64url");
  const at = Date.now();
  const db = database();
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(at);
  revokeSession(previousToken);
  db.prepare("INSERT INTO sessions (token_hash, merchant_account_id, owner_version, expires_at) VALUES (?, ?, ?, ?)")
    .run(fingerprint(token), user.role === "merchant" ? user.id : null, version, at + durationSeconds * 1000);
  return { user, token };
}

export function tokenFromRequest(request: Request) {
  return request.headers.get("cookie")?.match(/(?:^|;\s*)relay_session=([A-Za-z0-9_-]{43})(?=;|$)/)?.[1];
}

export function readSession(token?: string): SessionUser | null {
  if (!token || !cookieToken.test(token)) return null;
  const row = database().prepare(`
    SELECT s.merchant_account_id, s.owner_version, m.name
    FROM sessions s LEFT JOIN merchant_accounts m ON m.id = s.merchant_account_id
    WHERE s.token_hash = ? AND s.expires_at > ?
  `).get(fingerprint(token), Date.now()) as SessionRow | undefined;
  if (!row) return null;
  if (row.merchant_account_id && row.name) return { role: "merchant", id: row.merchant_account_id, name: row.name };
  if (row.owner_version && row.owner_version === ownerConfig()?.version) return { role: "owner", name: "Workspace owner" };
  return null;
}

export function revokeSession(token?: string) {
  if (token && cookieToken.test(token)) database().prepare("DELETE FROM sessions WHERE token_hash = ?").run(fingerprint(token));
}

export function requireSession(request: Request, role?: SessionUser["role"]): SessionUser {
  const user = readSession(tokenFromRequest(request));
  if (!user) throw new WorkflowError("Sign in to continue.", 401);
  if (role && user.role !== role) throw new WorkflowError("This action is unavailable in your workspace.", 403);
  return user;
}

export function checkRequestOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const host = request.headers.get("host");
  // Next.js can use a canonical hostname in its route URL on localhost.
  const browserOrigin = host ? `${url.protocol}//${host}` : url.origin;
  if ((origin && origin !== browserOrigin) || request.headers.get("sec-fetch-site") === "cross-site") {
    throw new WorkflowError("Open Relay directly to continue.", 403);
  }
}

export function sessionCookieHeader(request: Request, token = "") {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${token ? durationSeconds : 0}${secure}`;
}

export async function signUp(payload: unknown, previousToken?: string) {
  const data = record(payload);
  const name = textField(data.name, "your full name", 80);
  const email = emailAddress(data.email);
  if (!validPassword(data.password)) throw new WorkflowError("Choose a password with 12 to 128 characters.");
  countAttempt("merchant-signup", 30);
  const salt = randomBytes(16).toString("hex");
  const digest = await derivePassword(data.password, salt);
  const user: SessionUser = { role: "merchant", id: randomUUID(), name };
  return transaction(() => {
    const added = database().prepare(`
      INSERT INTO merchant_accounts (id, name, email, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING
    `).run(user.id, name, email, `${salt}:${digest.toString("hex")}`, Date.now()).changes;
    if (!added) throw new WorkflowError("An account with that email already exists. Sign in to continue.", 409);
    return issueSession(user, null, previousToken);
  });
}

export async function signIn(payload: unknown, previousToken?: string) {
  const data = record(payload);
  if (data.role === "owner") {
    countAttempt("owner-sign-in", 8);
    const credentials = ownerConfig();
    if (!credentials) throw new WorkflowError("Owner access is unavailable. Configure the owner credentials in .env.local.", 503);
    const id = typeof data.id === "string" ? data.id.slice(0, 254).trim().toLowerCase() : "";
    const password = typeof data.password === "string" ? data.password.slice(0, 128) : "";
    const idMatches = constantEqual(id, credentials.id) && typeof data.id === "string" && data.id.length <= 254;
    const passwordMatches = constantEqual(password, credentials.password) && validPassword(data.password);
    if (!idMatches || !passwordMatches) throw new WorkflowError("The owner ID or password is incorrect.", 401);
    return transaction(() => {
      database().prepare("DELETE FROM auth_limits WHERE scope = 'owner-sign-in'").run();
      return issueSession({ role: "owner", name: "Workspace owner" }, credentials.version, previousToken);
    });
  }
  if (data.role !== "merchant") throw new WorkflowError("Choose a workspace to sign in.");
  const email = emailAddress(data.email);
  const scope = `merchant-sign-in:${fingerprint(email)}`;
  countAttempt("merchant-sign-in-all", 60);
  countAttempt(scope, 10);
  const row = database().prepare("SELECT id, name, password_hash FROM merchant_accounts WHERE email = ?")
    .get(email) as AccountRow | undefined;
  const [salt, hash] = row?.password_hash.split(":") ?? ["0".repeat(32), "0".repeat(128)];
  const digest = await derivePassword(validPassword(data.password) ? data.password : "invalid", salt);
  const expected = Buffer.from(hash, "hex");
  if (!row || expected.length !== digest.length || !timingSafeEqual(expected, digest) || !validPassword(data.password)) {
    throw new WorkflowError("The email or password is incorrect.", 401);
  }
  return transaction(() => {
    database().prepare("DELETE FROM auth_limits WHERE scope = ?").run(scope);
    return issueSession({ role: "merchant", id: row.id, name: row.name }, null, previousToken);
  });
}
