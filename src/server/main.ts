import Fastify from "fastify";
import cookie from "@fastify/cookie";
import staticFiles from "@fastify/static";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ArrClient } from "./arr.ts";
import { ensureDefaultAdmin, hashPassword, newSession, removeSession, sessionFor, tokenHash, verifyPassword } from "./auth.ts";
import { snapshotFolder, validateTargetPath } from "./cleanup.ts";
import { allConnections, allTargets, connectionById, createJob, createUniqueJob, db, encrypt, isoNow, targetById } from "./db.ts";
import { log, logEvents } from "./logs.ts";
import { inspectFile, languages, normalizeLanguage, policyRevision } from "./policy.ts";
import { observedIdleSince, previewId, resetIdle, startWorker } from "./worker.ts";
import type { ArrKind, CleanupTarget, Connection, PreviewRow } from "./types.ts";

const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
// This listener is published to the LAN; it serves only token-authenticated webhooks.
const webhookApp = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
ensureDefaultAdmin();
await app.register(cookie);
const cookieSecure = process.env.ARRBITER_COOKIE_SECURE === "true";
const loginAttempts = new Map<string, { count: number; until: number }>();

function bad(message: string, code = 400): never { throw Object.assign(new Error(message), { statusCode: code }); }
function int(value: unknown): number { const n = Number(value); if (!Number.isInteger(n) || n < 1) bad("Invalid ID"); return n; }
function constantEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
function ensureUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { bad("Enter a valid HTTP(S) URL"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) bad("Use a plain HTTP(S) URL without credentials or query parameters");
  return url.toString().replace(/\/$/, "");
}
function validateWebhookCallback(kind: ArrKind, instanceUrl: string, callbackUrl: string, enabled: boolean, onImport: boolean, onUpgrade: boolean) {
  if (!enabled || (!onImport && !onUpgrade)) return;
  if (!callbackUrl) bad("Enter an Arrbiter callback URL before enabling import or upgrade checks.");
  const instance = new URL(instanceUrl);
  const callback = new URL(callbackUrl);
  if (callbackUrl === instanceUrl) bad(`The callback URL points to ${kind} itself. Enter an Arrbiter address reachable by this instance.`);
  if (["localhost", "127.0.0.1", "::1"].includes(callback.hostname.toLowerCase()) &&
      !["localhost", "127.0.0.1", "::1"].includes(instance.hostname.toLowerCase())) {
    bad(`The callback URL uses localhost on a remote ${kind} instance. Use this PC's LAN address and webhook port 8788.`);
  }
}
function safeConnection(connection: Connection) {
  const { api_key_enc, webhook_secret, ...safe } = connection;
  return { ...safe, hasApiKey: Boolean(api_key_enc), languages: JSON.parse(connection.languages) };
}
function credentialsCookie(reply: any, token: string) {
  reply.setCookie("arrbiter_session", token, { httpOnly: true, sameSite: "lax", secure: cookieSecure, path: "/", maxAge: 7 * 86400 });
}

app.addHook("onRequest", async (request) => {
  if (!request.url.startsWith("/api")) return;
  if (["/api/health", "/api/auth/status", "/api/auth/login"].includes(request.url.split("?")[0]) || request.url.startsWith("/api/webhooks/")) return;
  const session = sessionFor(request.cookies.arrbiter_session);
  if (!session) bad("Login required", 401);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers["x-csrf-token"] !== session.csrf) bad("Invalid CSRF token", 403);
});

app.setErrorHandler((error, request, reply) => {
  const issue = error as Error & { statusCode?: number };
  const status = issue.statusCode || 500;
  if (status >= 500) log("error", `Request failed: ${issue.message}`);
  reply.code(status).send({ error: status >= 500 ? "Internal error" : issue.message });
});
webhookApp.setErrorHandler((error, request, reply) => {
  const issue = error as Error & { statusCode?: number };
  const status = issue.statusCode || 500;
  if (status >= 500) log("error", `Webhook request failed: ${issue.message}`);
  reply.code(status).send({ error: status >= 500 ? "Internal error" : issue.message });
});

app.get("/api/health", async () => ({ ok: true }));
app.get("/api/auth/status", async (request) => {
  const admin = db.prepare("SELECT username,credentials_changed FROM admin WHERE id=1").get() as { username: string; credentials_changed: number };
  const session = sessionFor(request.cookies.arrbiter_session);
  return { authenticated: Boolean(session), username: session ? admin.username : undefined,
    mustChangeCredentials: !admin.credentials_changed, csrf: session?.csrf };
});
app.post("/api/auth/login", async (request, reply) => {
  const ip = request.ip;
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.count >= 5 && attempt.until > Date.now()) bad("Too many attempts; try again later", 429);
  const body = request.body as { username?: string; password?: string };
  const admin = db.prepare("SELECT username,password_hash,credentials_changed FROM admin WHERE id=1").get() as { username: string; password_hash: string; credentials_changed: number };
  if (!admin || body?.username !== admin.username || !body.password || !verifyPassword(body.password, admin.password_hash)) {
    loginAttempts.set(ip, { count: (attempt?.until || 0) > Date.now() ? attempt!.count + 1 : 1, until: Date.now() + 15 * 60_000 });
    bad("Invalid credentials", 401);
  }
  loginAttempts.delete(ip);
  const session = newSession(); credentialsCookie(reply, session.token);
  return { username: admin.username, mustChangeCredentials: !admin.credentials_changed, csrf: session.csrf };
});
app.post("/api/auth/logout", async (request, reply) => {
  removeSession(request.cookies.arrbiter_session);
  reply.clearCookie("arrbiter_session", { path: "/" });
  return { ok: true };
});
app.post("/api/auth/credentials", async (request) => {
  const body = request.body as { currentPassword?: string; username?: string; password?: string };
  const admin = db.prepare("SELECT username,password_hash FROM admin WHERE id=1").get() as { username: string; password_hash: string };
  const username = body?.username?.trim();
  const password = body?.password;
  if (!body?.currentPassword || !verifyPassword(body.currentPassword, admin.password_hash)) bad("Invalid current password", 403);
  if (!username || username.length > 60 || !password || password.length < 12) bad("Enter a username and a new password of at least 12 characters");
  if (verifyPassword(password, admin.password_hash)) bad("Choose a different password");
  db.transaction(() => {
    db.prepare("UPDATE admin SET username=?,password_hash=?,credentials_changed=1 WHERE id=1").run(username, hashPassword(password));
    db.prepare("DELETE FROM sessions WHERE token_hash<>?").run(tokenHash(request.cookies.arrbiter_session || ""));
  })();
  log("info", "Administrator credentials changed");
  return { username, mustChangeCredentials: false };
});

app.get("/api/dashboard", async () => ({
  connections: allConnections().map(safeConnection),
  targets: allTargets(),
  idleSince: observedIdleSince(),
  counts: {
    pendingJobs: (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('queued','running')").get() as { n: number }).n,
    reviews: (db.prepare("SELECT COUNT(*) AS n FROM activity WHERE status='review'").get() as { n: number }).n,
  },
  recentActivity: db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT 8").all(),
}));
app.get("/api/languages", async (request) => {
  const q = String((request.query as { q?: string }).q || "").toLowerCase();
  return languages.filter((language) => language.name.toLowerCase().includes(q) || language.code.includes(q)).slice(0, 100);
});

app.get("/api/connections", async () => allConnections().map(safeConnection));
app.post("/api/connections/test", async (request) => {
  const body = request.body as { kind: ArrKind; url: string; apiKey: string; callbackUrl?: string; enabled?: boolean; onImport?: boolean; onUpgrade?: boolean };
  if (!["sonarr", "radarr"].includes(body?.kind) || !body.apiKey) bad("Type and API key are required");
  const url = ensureUrl(body.url);
  validateWebhookCallback(body.kind, url, body.callbackUrl ? ensureUrl(body.callbackUrl) : "", Boolean(body.enabled), Boolean(body.onImport), Boolean(body.onUpgrade));
  const temporary = { kind: body.kind, url, api_key_enc: encrypt(body.apiKey) } as Connection;
  return new ArrClient(temporary).test();
});
app.post("/api/connections/:id/test", async (request) => {
  const connection = connectionById(int((request.params as { id: string }).id));
  if (!connection) bad("Connection not found", 404);
  const body = (request.body || {}) as { callbackUrl?: string; enabled?: boolean; onImport?: boolean; onUpgrade?: boolean };
  validateWebhookCallback(connection.kind, connection.url, body.callbackUrl ? ensureUrl(body.callbackUrl) : "", Boolean(body.enabled), Boolean(body.onImport), Boolean(body.onUpgrade));
  return new ArrClient(connection).test();
});

async function saveConnection(body: Record<string, unknown>, existing?: Connection) {
  const kind = body.kind as ArrKind;
  const name = String(body.name || "").trim();
  if (!["sonarr", "radarr"].includes(kind) || !name || name.length > 80) bad("Choose Sonarr/Radarr and a name");
  const url = ensureUrl(String(body.url || ""));
  if (existing && (kind !== existing.kind || url !== existing.url)) bad("Create a new connection to change its application or URL");
  const rawCallbackUrl = String(body.callbackUrl || "").trim();
  const callbackUrl = rawCallbackUrl ? ensureUrl(rawCallbackUrl) : "";
  const apiKey = String(body.apiKey || "");
  if (!apiKey && !existing) bad("API key required");
  const mode = body.policyMode === "block" ? "block" : "allow";
  const selected = Array.isArray(body.languages) ? [...new Set(body.languages.map((value) => normalizeLanguage(String(value))))] : [];
  if (selected.includes("unknown")) bad("Choose recognized languages");
  const enabled = Boolean(body.enabled);
  if (enabled && !selected.length) bad("Choose at least one language before activation");
  validateWebhookCallback(kind, url, callbackUrl, enabled, Boolean(body.onImport), Boolean(body.onUpgrade));
  const scanInterval = Number(body.scanIntervalHours || 24);
  if (![6, 12, 24, 168].includes(scanInterval)) bad("Invalid scan interval");
  const torrentTimeout = Number(body.torrentTimeoutMin || 1440);
  const usenetTimeout = Number(body.usenetTimeoutMin || 360);
  if (![torrentTimeout, usenetTimeout].every((value) => Number.isInteger(value) && value >= 30 && value <= 10080)) bad("Stall timeouts must be 30 minutes to 7 days");
  const connection = {
    id: existing?.id || 0, kind, name, url, api_key_enc: apiKey ? encrypt(apiKey) : existing!.api_key_enc,
    callback_url: callbackUrl, webhook_secret: existing?.webhook_secret || randomBytes(32).toString("base64url"),
    webhook_notification_id: existing?.webhook_notification_id || null, enabled: Number(enabled), policy_mode: mode,
    languages: JSON.stringify(selected), scan_enabled: Number(Boolean(body.scanEnabled)), scan_interval_hours: scanInterval,
    on_import: Number(Boolean(body.onImport)), on_upgrade: Number(Boolean(body.onUpgrade)),
    stall_enabled: Number(Boolean(body.stallEnabled)), torrent_timeout_min: torrentTimeout, usenet_timeout_min: usenetTimeout,
    next_scan_at: Boolean(body.scanEnabled) ? new Date(Date.now() + scanInterval * 3600_000).toISOString() : null,
    history_cursor: existing?.history_cursor || null,
  } satisfies Connection;
  await new ArrClient(connection).test();
  const stored = { ...connection, enabled: 0 };
  const update = db.prepare(`UPDATE connections SET kind=@kind,name=@name,url=@url,api_key_enc=@api_key_enc,callback_url=@callback_url,
      enabled=@enabled,policy_mode=@policy_mode,languages=@languages,scan_enabled=@scan_enabled,scan_interval_hours=@scan_interval_hours,
      on_import=@on_import,on_upgrade=@on_upgrade,stall_enabled=@stall_enabled,torrent_timeout_min=@torrent_timeout_min,
      usenet_timeout_min=@usenet_timeout_min,next_scan_at=@next_scan_at WHERE id=@id`);
  if (existing) {
    update.run(stored);
  } else {
    const result = db.prepare(`INSERT INTO connections(kind,name,url,api_key_enc,callback_url,webhook_secret,enabled,policy_mode,languages,
      scan_enabled,scan_interval_hours,on_import,on_upgrade,stall_enabled,torrent_timeout_min,usenet_timeout_min,next_scan_at)
      VALUES(@kind,@name,@url,@api_key_enc,@callback_url,@webhook_secret,@enabled,@policy_mode,@languages,
      @scan_enabled,@scan_interval_hours,@on_import,@on_upgrade,@stall_enabled,@torrent_timeout_min,@usenet_timeout_min,@next_scan_at)`).run(stored);
    connection.id = Number(result.lastInsertRowid);
  }
  if (enabled && (connection.on_import || connection.on_upgrade)) {
    try {
      const notificationId = await new ArrClient(connection).registerWebhook(connection.webhook_notification_id);
      db.prepare("UPDATE connections SET webhook_notification_id=? WHERE id=?").run(notificationId, connection.id);
    } catch (error) {
      if (existing) update.run(existing);
      else db.prepare("DELETE FROM connections WHERE id=?").run(connection.id);
      log("warn", `Webhook setup failed for ${name}: ${String(error)}`, connection.id);
      const status = String(error).match(/returned (\d{3})/)?.[1];
      bad(`${kind === "sonarr" ? "Sonarr" : "Radarr"} could not register the webhook${status ? ` (HTTP ${status})` : ""}. Connection was not saved. Check the callback URL and notification settings.`, 422);
    }
  }
  if (enabled) db.prepare("UPDATE connections SET enabled=1 WHERE id=?").run(connection.id);
  db.prepare("DELETE FROM observations WHERE connection_id=?").run(connection.id);
  resetIdle();
  log("info", `${existing ? "Updated" : "Added"} ${kind} connection ${name}`, connection.id);
  return safeConnection(connectionById(connection.id)!);
}
app.post("/api/connections", async (request) => saveConnection(request.body as Record<string, unknown>));
app.put("/api/connections/:id", async (request) => {
  const existing = connectionById(int((request.params as { id: string }).id));
  if (!existing) bad("Connection not found", 404);
  return saveConnection(request.body as Record<string, unknown>, existing);
});
app.delete("/api/connections/:id", async (request) => {
  const existing = connectionById(int((request.params as { id: string }).id));
  if (!existing) bad("Connection not found", 404);
  if (existing.webhook_notification_id) {
    try { await new ArrClient(existing).request("DELETE", `/notification/${existing.webhook_notification_id}`); }
    catch { bad("Could not remove Arrbiter webhook from the instance; retry when it is reachable", 409); }
  }
  db.prepare("DELETE FROM connections WHERE id=?").run(existing.id);
  db.prepare("DELETE FROM provenance WHERE connection_id=?").run(existing.id);
  resetIdle();
  return { ok: true };
});

app.post("/api/connections/:id/preview", async (request) => {
  const connection = connectionById(int((request.params as { id: string }).id));
  if (!connection) bad("Connection not found", 404);
  if (!(JSON.parse(connection.languages) as string[]).length) bad("Choose at least one language before scanning", 409);
  const client = new ArrClient(connection);
  const rows: PreviewRow[] = [];
  for (const file of await client.files()) rows.push(await inspectFile(client, connection, file));
  const id = previewId();
  db.prepare("INSERT INTO previews(id,kind,entity_id,manifest,created_at,expires_at) VALUES(?,'media',?,?,?,?)")
    .run(id, connection.id, JSON.stringify(rows), isoNow(), new Date(Date.now() + 30 * 60_000).toISOString());
  return { id, rows };
});
app.post("/api/previews/:id/apply", async (request) => {
  const preview = db.prepare("SELECT * FROM previews WHERE id=?").get((request.params as { id: string }).id) as { id: string; kind: string; entity_id: number; manifest: string; expires_at: string } | undefined;
  if (!preview || preview.expires_at <= isoNow()) bad("Preview expired; run it again", 409);
  let jobId: number;
  if (preview.kind === "media") {
    const rows = (JSON.parse(preview.manifest) as PreviewRow[]).filter((row) => row.status === "fail");
    const connection = connectionById(preview.entity_id);
    if (!connection || !JSON.parse(connection.languages).length || rows.some((row) => row.connectionId !== connection.id || row.policyRevision !== policyRevision(connection))) {
      bad("Connection or language policy changed; run a new preview", 409);
    }
    if (!rows.length) bad("No failed files in this preview", 409);
    jobId = createJob("media-apply", preview.entity_id, undefined, { rows });
  } else {
    jobId = createJob("cleanup", undefined, preview.entity_id, { manifest: JSON.parse(preview.manifest) });
  }
  db.prepare("DELETE FROM previews WHERE id=?").run(preview.id);
  return { jobId };
});

app.get("/api/cleanup-targets", async () => allTargets());
async function saveTarget(body: Record<string, unknown>, existing?: CleanupTarget) {
  const name = String(body.name || "").trim();
  const path = String(body.path || "");
  const interval = Number(body.intervalHours || 24);
  if (!name || name.length > 80 || ![6, 12, 24, 168].includes(interval)) bad("Name or interval is invalid");
  const actual = await validateTargetPath(path, allTargets().filter((item) => item.id !== existing?.id).map((item) => item.path));
  const enabled = Number(Boolean(body.enabled));
  const next = enabled ? new Date(Date.now() + interval * 3600_000).toISOString() : null;
  if (existing) db.prepare("UPDATE cleanup_targets SET name=?,path=?,interval_hours=?,enabled=?,next_run_at=? WHERE id=?").run(name, actual, interval, enabled, next, existing.id);
  else db.prepare("INSERT INTO cleanup_targets(name,path,interval_hours,enabled,next_run_at) VALUES(?,?,?,?,?)").run(name, actual, interval, enabled, next);
  resetIdle();
  return { ok: true };
}
app.post("/api/cleanup-targets", async (request) => saveTarget(request.body as Record<string, unknown>));
app.put("/api/cleanup-targets/:id", async (request) => {
  const existing = targetById(int((request.params as { id: string }).id));
  if (!existing) bad("Target not found", 404);
  return saveTarget(request.body as Record<string, unknown>, existing);
});
app.delete("/api/cleanup-targets/:id", async (request) => {
  db.prepare("DELETE FROM cleanup_targets WHERE id=?").run(int((request.params as { id: string }).id));
  return { ok: true };
});
app.post("/api/cleanup-targets/:id/preview", async (request) => {
  const target = targetById(int((request.params as { id: string }).id));
  if (!target) bad("Target not found", 404);
  const manifest = await snapshotFolder(target);
  const id = previewId();
  db.prepare("INSERT INTO previews(id,kind,entity_id,manifest,created_at,expires_at) VALUES(?,'cleanup',?,?,?,?)")
    .run(id, target.id, JSON.stringify(manifest), isoNow(), new Date(Date.now() + 30 * 60_000).toISOString());
  return { id, entries: manifest.length - 1, bytes: manifest.filter((entry) => entry.kind === "file").reduce((sum, entry) => sum + entry.size, 0), sample: manifest.filter((entry) => entry.path).slice(0, 100) };
});

app.get("/api/jobs", async () => db.prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT 100").all());
app.get("/api/jobs/:id", async (request) => {
  const id = int((request.params as { id: string }).id);
  const job = db.prepare("SELECT id,kind,state,connection_id,created_at,started_at,finished_at,error,payload FROM jobs WHERE id=?").get(id) as
    | { id: number; kind: string; state: string; connection_id: number | null; created_at: string; started_at: string | null; finished_at: string | null; error: string | null; payload: string }
    | undefined;
  if (!job) bad("Job not found", 404);
  const { payload, ...details } = job;
  const total = job.kind === "media-apply" ? (JSON.parse(payload) as { rows?: PreviewRow[] }).rows?.length || 0 : 0;
  const outcomes = job.kind === "media-apply"
    ? db.prepare("SELECT status,message,created_at FROM activity WHERE job_id=? AND kind='media' AND status IN ('done','error') ORDER BY id").all(id) as Array<{ status: string; message: string; created_at: string }>
    : [];
  return { ...details, total, completed: outcomes.length, succeeded: outcomes.filter((item) => item.status === "done").length,
    failed: outcomes.filter((item) => item.status === "error").length, outcomes };
});
app.get("/api/activity", async (request) => {
  const query = request.query as { limit?: string };
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
  return db.prepare("SELECT * FROM activity ORDER BY id DESC LIMIT ?").all(limit);
});
function logRows(query: Record<string, unknown>, limit?: number) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (query.level) { clauses.push("level=?"); params.push(String(query.level)); }
  if (query.connectionId) { clauses.push("connection_id=?"); params.push(int(query.connectionId)); }
  if (query.jobId) { clauses.push("job_id=?"); params.push(int(query.jobId)); }
  if (query.from) { clauses.push("created_at>=?"); params.push(String(query.from)); }
  if (query.to) { clauses.push("created_at<=?"); params.push(String(query.to)); }
  return db.prepare(`SELECT * FROM logs ${clauses.length ? "WHERE " + clauses.join(" AND ") : ""} ORDER BY id DESC${limit ? " LIMIT " + limit : ""}`).all(...params) as Array<Record<string, unknown>>;
}
app.get("/api/logs", async (request) => logRows(request.query as Record<string, unknown>, 500));
app.get("/api/logs/export", async (request, reply) => {
  const query = request.query as Record<string, unknown>;
  const rows = logRows(query).reverse();
  const format = query.format === "text" ? "text" : "jsonl";
  const data = format === "jsonl" ? rows.map((row) => JSON.stringify(row)).join("\n") : rows.map((row) => `${row.created_at} [${row.level}] ${row.message} ${row.details}`).join("\n");
  reply.header("Content-Type", format === "text" ? "text/plain; charset=utf-8" : "application/x-ndjson");
  reply.header("Content-Disposition", `attachment; filename="arrbiter-logs.${format === "text" ? "txt" : "jsonl"}"`);
  return data + "\n";
});
app.get("/api/logs/stream", async (request, reply) => {
  reply.hijack();
  reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  reply.raw.write(": connected\n\n");
  const send = (row: unknown) => reply.raw.write(`data: ${JSON.stringify(row)}\n\n`);
  const heartbeat = setInterval(() => {
    if (!sessionFor(request.cookies.arrbiter_session)) { reply.raw.end(); return; }
    reply.raw.write(": ping\n\n");
  }, 20_000);
  logEvents.on("entry", send);
  request.raw.on("close", () => { clearInterval(heartbeat); logEvents.off("entry", send); });
});

const handleWebhook = async (request: any, reply: any) => {
  const connection = connectionById(int((request.params as { id: string }).id));
  if (!connection || !constantEqual(String(request.headers["x-arrbiter-token"] || ""), connection.webhook_secret)) bad("Invalid webhook", 401);
  const event = request.body as Record<string, any>;
  const eventType = String(event?.eventType || "").toLowerCase();
  // Radarr/Sonarr send a test before the connection is activated.
  if (eventType === "test") return reply.code(202).send({ accepted: true });
  if (!connection.enabled) return reply.code(202).send({ ignored: true });
  const isUpgrade = eventType === "upgrade" || event.isUpgrade === true;
  if (!["download", "upgrade"].includes(eventType) || (isUpgrade ? !connection.on_upgrade : !connection.on_import)) return reply.code(202).send({ ignored: true });
  const file = connection.kind === "sonarr" ? event.episodeFile : event.movieFile;
  if (!Number.isInteger(file?.id)) bad("Missing file ID");
  const downloadId = String(event.downloadId || "");
  if (downloadId) db.prepare("INSERT OR REPLACE INTO provenance(connection_id,file_id,download_id,episode_ids,created_at) VALUES(?,?,?,?,?)")
    .run(connection.id, file.id, downloadId, JSON.stringify((event.episodes || []).map((episode: { id: number }) => episode.id)), isoNow());
  resetIdle();
  const key = `webhook:${connection.id}:${file.id}:${downloadId}:${eventType}:${file.dateAdded || ""}`;
  createUniqueJob(key, "media-file", connection.id, undefined, { fileId: file.id, isUpgrade });
  return reply.code(202).send({ accepted: true });
};
app.post("/api/webhooks/:id", handleWebhook);
webhookApp.post("/api/webhooks/:id", handleWebhook);

const staticRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../client");
if (process.env.NODE_ENV === "production") {
  await app.register(staticFiles, { root: staticRoot, prefix: "/" });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api")) return reply.code(404).send({ error: "Not found" });
    return reply.type("text/html").send(readFileSync(join(staticRoot, "index.html")));
  });
}

const port = Number(process.env.ARRBITER_PORT || 8787);
await app.listen({ host: "0.0.0.0", port });
log("info", `Arrbiter listening on port ${port}`);
const webhookPort = Number(process.env.ARRBITER_WEBHOOK_PORT || 0);
if (webhookPort) {
  if (!Number.isInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535 || webhookPort === port) throw new Error("Invalid webhook port");
  await webhookApp.listen({ host: "0.0.0.0", port: webhookPort });
  log("info", `Webhook listener ready on port ${webhookPort}`);
}
startWorker();
