import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

declare global {
  var relayDb: DatabaseSync | undefined;
}

export function database() {
  if (globalThis.relayDb) return globalThis.relayDb;
  const path = resolve(/*turbopackIgnore: true*/ process.env.RELAY_DB_PATH ?? "data/relay.sqlite");
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS merchant_accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      merchant_account_id TEXT REFERENCES merchant_accounts(id) ON DELETE CASCADE,
      owner_version TEXT,
      expires_at INTEGER NOT NULL,
      CHECK ((merchant_account_id IS NULL) <> (owner_version IS NULL))
    );
    CREATE INDEX IF NOT EXISTS session_expiration ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS auth_limits (
      scope TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL,
      reset_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS applications (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE,
      input TEXT NOT NULL,
      state TEXT NOT NULL,
      state_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      correction_kind TEXT,
      correction_reason TEXT,
      setup TEXT NOT NULL DEFAULT 'idle',
      merchant_id TEXT UNIQUE,
      fail_next INTEGER NOT NULL DEFAULT 0,
      merchant_account_id TEXT REFERENCES merchant_accounts(id)
    );

    CREATE TABLE IF NOT EXISTS check_attempts (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id),
      kind TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      is_current INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      due_at INTEGER,
      evidence TEXT NOT NULL,
      provider_payload TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS current_check
      ON check_attempts(application_id, kind) WHERE is_current = 1;

    CREATE TABLE IF NOT EXISTS setup_attempts (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id),
      status TEXT NOT NULL,
      due_at INTEGER NOT NULL,
      should_fail INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pending_setup
      ON setup_attempts(application_id) WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS callbacks (
      id TEXT PRIMARY KEY,
      application_id TEXT NOT NULL REFERENCES applications(id),
      target_id TEXT NOT NULL,
      type TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      disposition TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id TEXT NOT NULL REFERENCES applications(id),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      actor TEXT NOT NULL,
      at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY);

    CREATE TABLE IF NOT EXISTS callback_jobs (
      type TEXT NOT NULL CHECK (type IN ('check', 'setup')),
      target_id TEXT NOT NULL,
      application_id TEXT NOT NULL REFERENCES applications(id),
      status TEXT NOT NULL CHECK (status IN ('held', 'scheduled', 'leased', 'received', 'dead', 'cancelled')),
      available_at INTEGER,
      delivery_count INTEGER NOT NULL DEFAULT 0,
      lease_id TEXT,
      lease_until INTEGER,
      forced_failures INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (type, target_id)
    );
    CREATE INDEX IF NOT EXISTS callback_jobs_due ON callback_jobs(status, available_at, lease_until);
    CREATE INDEX IF NOT EXISTS callback_jobs_application ON callback_jobs(application_id, status);

    CREATE TABLE IF NOT EXISTS duplicate_clearances (
      application_id TEXT NOT NULL REFERENCES applications(id),
      matched_id TEXT NOT NULL REFERENCES applications(id),
      signature TEXT NOT NULL,
      PRIMARY KEY (application_id, matched_id)
    );

    CREATE TABLE IF NOT EXISTS application_exceptions (
      application_id TEXT PRIMARY KEY REFERENCES applications(id),
      first_at INTEGER NOT NULL
    );
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    const columns = db.prepare("PRAGMA table_info(applications)").all();
    if (!columns.some(column => column.name === "merchant_account_id")) {
      db.exec("ALTER TABLE applications ADD COLUMN merchant_account_id TEXT REFERENCES merchant_accounts(id)");
    }
    if (!columns.some(column => column.name === "required_checks")) {
      db.exec(`ALTER TABLE applications ADD COLUMN required_checks TEXT NOT NULL DEFAULT '["pan","gst","bank"]'`);
    }
    if (!columns.some(column => column.name === "correction_items")) {
      db.exec("ALTER TABLE applications ADD COLUMN correction_items TEXT");
    }
    db.exec("CREATE INDEX IF NOT EXISTS applications_by_merchant ON applications(merchant_account_id, updated_at)");
    if (!db.prepare("SELECT 1 FROM metadata WHERE key = 'workflow-delivery-v1'").get()) {
      const auto = process.env.RELAY_VERIFICATION_MODE !== "hold" ? 1 : 0;
      db.prepare(`
        INSERT INTO callback_jobs (type, target_id, application_id, status, available_at)
        SELECT 'check', c.id, c.application_id,
          CASE WHEN c.due_at IS NOT NULL OR (? = 1 AND a.merchant_account_id IS NOT NULL AND c.is_current = 1
              AND c.status = 'pending') THEN 'scheduled' ELSE 'held' END,
          COALESCE(c.due_at, ?)
        FROM check_attempts c JOIN applications a ON a.id = c.application_id
        WHERE (c.status = 'pending' OR c.status = 'timed_out')
          AND NOT EXISTS (SELECT 1 FROM callbacks r WHERE r.id = 'verification:' || c.id)
      `).run(auto, Date.now());
      db.exec(`
        INSERT INTO callback_jobs (type, target_id, application_id, status, available_at)
        SELECT 'setup', id, application_id, 'scheduled', due_at FROM setup_attempts WHERE status = 'pending';
        INSERT INTO application_exceptions (application_id, first_at)
        SELECT application_id, MIN(at) FROM activity
        WHERE title IN ('Verification timed out', 'Correction requested', 'Merchant ID setup failed')
          OR (title = 'Application state changed' AND description LIKE '%Needs review')
        GROUP BY application_id;
        CREATE INDEX IF NOT EXISTS activity_submissions ON activity(at, application_id) WHERE title = 'Application submitted';
        INSERT INTO metadata (key) VALUES ('workflow-delivery-v1');
      `);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }
  globalThis.relayDb = db;
  return db;
}

export function transaction<T>(action: () => T): T {
  const db = database();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
