import { randomUUID } from "node:crypto";
import { database } from "./db";

export type DeliveryType = "check" | "setup";
export type DeliveryJob = {
  type: DeliveryType;
  target_id: string;
  application_id: string;
  status: "held" | "scheduled" | "leased" | "received" | "dead" | "cancelled";
  available_at: number | null;
  delivery_count: number;
  lease_id: string | null;
  lease_until: number | null;
  forced_failures: number;
};

const retryDelays = [2000, 5000, 15000];
const leaseMs = 30_000;
const db = database;

export function queueDelivery(type: DeliveryType, target: string, application: string, at: number, held = false) {
  db().prepare(`
    INSERT INTO callback_jobs (type, target_id, application_id, status, available_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(type, target, application, held ? "held" : "scheduled", held ? null : at);
}

export function deliveryJob(type: DeliveryType, target: string) {
  return db().prepare("SELECT * FROM callback_jobs WHERE type = ? AND target_id = ?").get(type, target) as DeliveryJob | undefined;
}

export function markReceived(type: DeliveryType, target: string) {
  db().prepare(`
    UPDATE callback_jobs SET status = 'received', available_at = NULL, lease_id = NULL, lease_until = NULL
    WHERE type = ? AND target_id = ? AND status <> 'dead'
  `).run(type, target);
}

export function expiredDeliveries(at: number) {
  return db().prepare(`
    SELECT * FROM callback_jobs WHERE status = 'leased' AND lease_until <= ? ORDER BY lease_until LIMIT 30
  `).all(at) as unknown as DeliveryJob[];
}

export function claimDelivery(at: number) {
  const job = db().prepare(`
    SELECT * FROM callback_jobs WHERE status = 'scheduled' AND available_at <= ? ORDER BY available_at, target_id LIMIT 1
  `).get(at) as DeliveryJob | undefined;
  if (!job) return null;
  const lease = randomUUID();
  db().prepare(`
    UPDATE callback_jobs SET status = 'leased', lease_id = ?, lease_until = ?, delivery_count = delivery_count + 1
    WHERE type = ? AND target_id = ?
  `).run(lease, at + leaseMs, job.type, job.target_id);
  return { type: job.type, id: job.target_id, lease };
}

export function failDelivery(job: DeliveryJob, at: number, retryable: boolean) {
  const delay = retryable ? retryDelays[job.delivery_count - 1] : undefined;
  const dead = delay === undefined;
  db().prepare(`
    UPDATE callback_jobs SET status = ?, available_at = ?, lease_id = NULL, lease_until = NULL
    WHERE type = ? AND target_id = ?
  `).run(dead ? "dead" : "scheduled", dead ? null : at + delay, job.type, job.target_id);
  return dead;
}
