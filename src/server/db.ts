import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { join } from "node:path";
import type { CleanupTarget, Connection } from "./types.ts";

export const configDir = process.env.ARRBITER_CONFIG_DIR || "/config";
mkdirSync(configDir, { recursive: true });
const keyPath = join(configDir, "master.key");
if (!existsSync(keyPath)) {
  writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
}
try { chmodSync(keyPath, 0o600); } catch { /* Filesystems may not support POSIX modes. */ }
const masterKey = readFileSync(keyPath);
if (masterKey.length !== 32) throw new Error("Invalid /config/master.key");

export const db = new Database(join(configDir, "arrbiter.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1), username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, credentials_changed INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connections (
 id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('sonarr','radarr')), name TEXT NOT NULL,
 url TEXT NOT NULL, api_key_enc TEXT NOT NULL, callback_url TEXT NOT NULL, webhook_secret TEXT NOT NULL,
 webhook_notification_id INTEGER, enabled INTEGER NOT NULL DEFAULT 0,
 policy_mode TEXT NOT NULL DEFAULT 'allow', languages TEXT NOT NULL DEFAULT '[]',
 scan_enabled INTEGER NOT NULL DEFAULT 0, scan_interval_hours INTEGER NOT NULL DEFAULT 24,
 on_import INTEGER NOT NULL DEFAULT 1, on_upgrade INTEGER NOT NULL DEFAULT 1,
 stall_enabled INTEGER NOT NULL DEFAULT 0, torrent_timeout_min INTEGER NOT NULL DEFAULT 1440,
 usenet_timeout_min INTEGER NOT NULL DEFAULT 360, next_scan_at TEXT, history_cursor TEXT
);
CREATE TABLE IF NOT EXISTS cleanup_targets (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, interval_hours INTEGER NOT NULL DEFAULT 24,
 enabled INTEGER NOT NULL DEFAULT 0, next_run_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
 id INTEGER PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, connection_id INTEGER,
 target_id INTEGER, payload TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
 started_at TEXT, finished_at TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS activity (
 id INTEGER PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL,
 connection_id INTEGER, job_id INTEGER, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS logs (
 id INTEGER PRIMARY KEY, level TEXT NOT NULL, message TEXT NOT NULL, connection_id INTEGER,
 job_id INTEGER, details TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS provenance (
 connection_id INTEGER NOT NULL, file_id INTEGER NOT NULL, download_id TEXT NOT NULL,
 episode_ids TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
 PRIMARY KEY(connection_id,file_id)
);
CREATE TABLE IF NOT EXISTS observations (
 connection_id INTEGER NOT NULL, download_id TEXT NOT NULL, queue_id INTEGER NOT NULL,
 remaining REAL NOT NULL, state TEXT NOT NULL, last_progress_at TEXT NOT NULL, observed_at TEXT NOT NULL,
 PRIMARY KEY(connection_id,download_id)
);
CREATE TABLE IF NOT EXISTS previews (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id INTEGER NOT NULL, manifest TEXT NOT NULL,
 created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dedupe (key TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_activity_time ON activity(created_at);
CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(state);
`);
// Existing administrator accounts were configured through the earlier setup flow.
if (!(db.pragma("table_info(admin)") as Array<{ name: string }>).some((column) => column.name === "credentials_changed")) {
  db.exec("ALTER TABLE admin ADD COLUMN credentials_changed INTEGER NOT NULL DEFAULT 1");
}
// A downtime cannot count as observed lack of download progress.
db.prepare("DELETE FROM observations").run();
db.prepare("UPDATE jobs SET state='failed', error='Interrupted by restart', finished_at=? WHERE state='running'").run(new Date().toISOString());

export function encrypt(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64url")).join(".");
}

export function decrypt(encoded: string): string {
  const [iv, tag, data] = encoded.split(".").map((part) => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export const allConnections = () => db.prepare("SELECT * FROM connections ORDER BY name").all() as Connection[];
export const enabledConnections = () => db.prepare("SELECT * FROM connections WHERE enabled=1 ORDER BY id").all() as Connection[];
export const connectionById = (id: number) => db.prepare("SELECT * FROM connections WHERE id=?").get(id) as Connection | undefined;
export const allTargets = () => db.prepare("SELECT * FROM cleanup_targets ORDER BY name").all() as CleanupTarget[];
export const targetById = (id: number) => db.prepare("SELECT * FROM cleanup_targets WHERE id=?").get(id) as CleanupTarget | undefined;
export const isoNow = () => new Date().toISOString();

export function recordActivity(kind: string, status: string, message: string, connectionId?: number, jobId?: number, details: unknown = {}) {
  db.prepare("INSERT INTO activity(kind,status,message,connection_id,job_id,details,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(kind, status, message, connectionId ?? null, jobId ?? null, JSON.stringify(details), isoNow());
}

export function markDedupe(key: string): boolean {
  return db.prepare("INSERT OR IGNORE INTO dedupe(key,created_at) VALUES(?,?)").run(key, isoNow()).changes === 1;
}

export function createJob(kind: string, connectionId?: number, targetId?: number, payload: unknown = {}): number {
  return Number(db.prepare("INSERT INTO jobs(kind,state,connection_id,target_id,payload,created_at) VALUES(?,'queued',?,?,?,?)")
    .run(kind, connectionId ?? null, targetId ?? null, JSON.stringify(payload), isoNow()).lastInsertRowid);
}

export function createUniqueJob(key: string, kind: string, connectionId?: number, targetId?: number, payload: unknown = {}): number | null {
  return db.transaction(() => markDedupe(key) ? createJob(kind, connectionId, targetId, payload) : null)();
}
