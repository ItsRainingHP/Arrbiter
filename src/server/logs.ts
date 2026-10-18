import { EventEmitter } from "node:events";
import { db, isoNow } from "./db.ts";

export const logEvents = new EventEmitter();
logEvents.setMaxListeners(200);

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/((?:x-api-key|api[ _-]?key|password|token|secret)\s*[:=]\s*)[^\s,;&]+/gi, "$1[redacted]");
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, /key|password|token|secret|authorization/i.test(key) ? "[redacted]" : redact(part)]));
  }
  return value;
}

export function log(level: "info" | "warn" | "error", message: string, connectionId?: number, jobId?: number, details: unknown = {}) {
  const event = { level, message: String(redact(message)), connectionId: connectionId ?? null, jobId: jobId ?? null, details: redact(details), createdAt: isoNow() };
  const result = db.prepare("INSERT INTO logs(level,message,connection_id,job_id,details,created_at) VALUES(?,?,?,?,?,?)")
    .run(event.level, event.message, event.connectionId, event.jobId, JSON.stringify(event.details), event.createdAt);
  const row = { id: Number(result.lastInsertRowid), ...event };
  process.stdout.write(JSON.stringify(row) + "\n");
  logEvents.emit("entry", row);
  return row;
}

export function pruneLogs() {
  const before = new Date(Date.now() - 30 * 86400_000).toISOString();
  db.prepare("DELETE FROM logs WHERE created_at<?").run(before);
  db.prepare("DELETE FROM sessions WHERE expires_at<?").run(isoNow());
  db.prepare("DELETE FROM previews WHERE expires_at<?").run(isoNow());
  db.prepare("DELETE FROM dedupe WHERE created_at<?").run(before);
}
