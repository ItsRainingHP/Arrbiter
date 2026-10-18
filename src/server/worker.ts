import { randomUUID } from "node:crypto";
import { ArrClient } from "./arr.ts";
import { applyCleanup, snapshotFolder } from "./cleanup.ts";
import { allTargets, connectionById, createJob, createUniqueJob, db, enabledConnections, isoNow, recordActivity, targetById } from "./db.ts";
import { log, pruneLogs } from "./logs.ts";
import { inspectFile, policyRevision } from "./policy.ts";
import type { Connection, HistoryItem, MediaFile, PreviewRow, QueueItem } from "./types.ts";

type Job = { id: number; kind: string; connection_id: number | null; target_id: number | null; payload: string };
let working = false;
let ticking = false;
let idleSince: number | null = null;
let lastReconcile = 0;

function activity(kind: string, status: string, message: string, connectionId?: number, jobId?: number, details: unknown = {}) {
  recordActivity(kind, status, message, connectionId, jobId, details);
  log(status === "error" || status === "review" ? "warn" : "info", message, connectionId, jobId, details);
}

export async function allInstancesIdle(): Promise<boolean> {
  const connections = enabledConnections();
  if (!connections.length) { idleSince = null; return false; }
  for (const connection of connections) {
    try {
      const client = new ArrClient(connection);
      if ((await client.queue()).length || await client.hasImportCommands()) { idleSince = null; return false; }
    } catch (error) {
      idleSince = null;
      log("warn", `Cannot verify activity for ${connection.name}`, connection.id, undefined, { error: String(error) });
      return false;
    }
  }
  return true;
}

async function confirmBlocklist(client: ArrClient, titleId: number, sourceTitle: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await client.blocklisted(titleId, sourceTitle)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return false;
}

async function confirmQueueGone(client: ArrClient, queueId: number, downloadId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await client.queue()).some((item) => item.id === queueId || item.downloadId === downloadId)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  return false;
}

async function searchOnce(client: ArrClient, titleId: number, episodeIds: number[]) {
  if (client.connection.kind === "sonarr" && !episodeIds.length) throw new Error("No episode IDs available for a targeted search");
  if (!await client.searchQueued(titleId, episodeIds)) await client.search(titleId, episodeIds);
}

export async function remediateMedia(row: PreviewRow, jobId: number, manual = false) {
  const connection = connectionById(row.connectionId);
  if (!connection || (!manual && !connection.enabled) || policyRevision(connection) !== row.policyRevision) throw new Error("Connection or policy changed; media action stopped");
  if (row.status !== "fail" || !row.historyId || !row.releaseTitle || !row.titleId) throw new Error("Media action lacks verified grab provenance");
  const client = new ArrClient(connection);
  const fresh = await client.file(row.file.id);
  if (fresh.path !== row.file.path || fresh.size !== row.file.size || fresh.dateAdded !== row.file.dateAdded) throw new Error("Media file changed; action stopped");
  const checked = await inspectFile(client, connection, fresh);
  if (checked.status !== "fail" || checked.historyId !== row.historyId || checked.releaseTitle !== row.releaseTitle) throw new Error("Language or grab changed; action stopped");
  await client.markFailed(row.historyId);
  if (!await confirmBlocklist(client, row.titleId, row.releaseTitle)) throw new Error("Source blocklist was not confirmed; file retained");
  await client.deleteFile(row.file.id);
  await searchOnce(client, row.titleId, row.episodeIds);
  activity("media", "done", `Removed noncompliant file ${row.file.path || row.file.id} and requested replacement`, connection.id, jobId, { audio: row.audio, release: row.releaseTitle });
}

async function runMediaScan(connection: Connection, jobId: number, fileId?: number) {
  const client = new ArrClient(connection);
  const files = fileId ? [await client.file(fileId)] : await client.files();
  let failed = 0;
  for (const file of files) {
    try {
      const row = await inspectFile(client, connection, file);
      if (row.status === "fail") await remediateMedia(row, jobId);
      else if (row.status === "review") activity("media", "review", `File ${file.path || file.id}: ${row.reason}`, connection.id, jobId);
    } catch (error) {
      failed++;
      activity("media", "error", `File ${file.path || file.id}: ${String(error)}`, connection.id, jobId);
    }
  }
  if (failed) throw new Error(`${failed} media file action${failed === 1 ? "" : "s"} failed`);
}

export async function runStall(connection: Connection, jobId: number, payload: { downloadId: string; queueId: number; remaining: number; titleId: number; episodeIds: number[]; sourceTitle: string }) {
  idleSince = null;
  const client = new ArrClient(connection);
  const items = await client.queue();
  const current = items.find((item) => item.id === payload.queueId && item.downloadId === payload.downloadId);
  if (!current || current.trackedDownloadState !== "downloading" || current.status !== "downloading" || current.sizeleft !== payload.remaining || current.title !== payload.sourceTitle || (connection.kind === "sonarr" ? current.seriesId : current.movieId) !== payload.titleId) throw new Error("Download progressed or changed before removal");
  if (connection.kind === "sonarr") {
    const currentEpisodes = new Set(items.filter((item) => item.downloadId === payload.downloadId).map((item) => item.episodeId));
    if (payload.episodeIds.some((id) => !currentEpisodes.has(id))) throw new Error("Download episodes changed before removal");
  }
  const observation = db.prepare("SELECT last_progress_at FROM observations WHERE connection_id=? AND download_id=?").get(connection.id, payload.downloadId) as { last_progress_at: string } | undefined;
  const timeout = current.protocol === "torrent" ? connection.torrent_timeout_min : connection.usenet_timeout_min;
  if (!observation || Date.now() - Date.parse(observation.last_progress_at) < timeout * 60_000) throw new Error("Stall interval is no longer satisfied");
  for (const other of enabledConnections().filter((item) => item.id !== connection.id)) {
    const peer = (await new ArrClient(other).queue()).find((item) => item.downloadId === payload.downloadId);
    if (peer) throw new Error("Another connected instance is using this download");
  }
  await client.removeQueue(current.id);
  if (!await confirmQueueGone(client, current.id, payload.downloadId)) throw new Error("Download removal could not be confirmed; replacement search withheld");
  if (!await confirmBlocklist(client, payload.titleId, payload.sourceTitle)) throw new Error("Download removed, but source blocklist could not be confirmed");
  await searchOnce(client, payload.titleId, payload.episodeIds);
  activity("stall", "done", `Removed stalled ${current.protocol} download ${current.title || current.id} and requested replacement`, connection.id, jobId, { release: payload.sourceTitle });
  db.prepare("DELETE FROM observations WHERE connection_id=? AND download_id=?").run(connection.id, payload.downloadId);
  idleSince = null;
}

async function runCleanup(jobId: number, targetId: number, manifest?: Awaited<ReturnType<typeof snapshotFolder>>) {
  const target = targetById(targetId);
  if (!target) throw new Error("Cleanup target no longer exists");
  if (!manifest && !target.enabled) throw new Error("Cleanup target is disabled");
  if (!await allInstancesIdle() || idleSince === null || Date.now() - idleSince < 30 * 60_000) throw new Error("All instances have not been idle for 30 minutes");
  const result = await applyCleanup(target, manifest || await snapshotFolder(target), allInstancesIdle);
  activity("cleanup", "done", `Cleaned ${target.name}: ${result.deleted} removed, ${result.skipped} skipped`, undefined, jobId, { targetId, ...result });
}

async function runJob(job: Job) {
  db.prepare("UPDATE jobs SET state='running', started_at=? WHERE id=?").run(isoNow(), job.id);
  try {
    const payload = JSON.parse(job.payload) as Record<string, any>;
    if (job.kind === "media-scan" || job.kind === "media-file") {
      const connection = connectionById(job.connection_id!);
      if (!connection || !connection.enabled) throw new Error("Connection is disabled or missing");
      if (job.kind === "media-file" && (payload.isUpgrade === true ? !connection.on_upgrade : payload.isUpgrade === false ? !connection.on_import : !connection.on_import || !connection.on_upgrade)) throw new Error("New-media check was disabled or changed");
      await runMediaScan(connection, job.id, payload.fileId);
    } else if (job.kind === "media-apply") {
      let failed = 0;
      for (const row of payload.rows as PreviewRow[]) {
        try { await remediateMedia(row, job.id, true); }
        catch (error) {
          failed++;
          activity("media", "error", `File ${row.file.path || row.file.id}: ${String(error)}`, row.connectionId, job.id);
        }
      }
      if (failed) throw new Error(`${failed} of ${(payload.rows as PreviewRow[]).length} media file actions failed; review individual results`);
    } else if (job.kind === "stall") {
      const connection = connectionById(job.connection_id!);
      if (!connection || !connection.enabled || !connection.stall_enabled) throw new Error("Stall handling is disabled");
      await runStall(connection, job.id, payload as Parameters<typeof runStall>[2]);
    } else if (job.kind === "cleanup") {
      await runCleanup(job.id, job.target_id!, payload.manifest);
    } else throw new Error(`Unknown job type ${job.kind}`);
    db.prepare("UPDATE jobs SET state='done', finished_at=? WHERE id=?").run(isoNow(), job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare("UPDATE jobs SET state='failed', error=?, finished_at=? WHERE id=?").run(message, isoNow(), job.id);
    activity(job.kind, "error", message, job.connection_id ?? undefined, job.id);
  }
}

async function drainJobs() {
  if (working) return;
  working = true;
  try {
    while (true) {
      const job = db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY id LIMIT 1").get() as Job | undefined;
      if (!job) break;
      await runJob(job);
    }
  } finally { working = false; }
}

export async function pollStalls(connection: Connection, items: QueueItem[]) {
  if (!connection.stall_enabled) return;
  const now = isoNow();
  const active = new Set<string>();
  for (const item of items) {
    if (!item.downloadId || !["torrent", "usenet"].includes(item.protocol || "")) continue;
    const key = item.downloadId;
    if (item.trackedDownloadState !== "downloading" || item.status !== "downloading") {
      db.prepare("DELETE FROM observations WHERE connection_id=? AND download_id=?").run(connection.id, key);
      continue;
    }
    if (!Number.isFinite(item.sizeleft) || !Number.isFinite(item.size) || (item.sizeleft ?? 0) <= 0) {
      activity("stall", "review", `Cannot measure progress for ${item.title || key}`, connection.id);
      continue;
    }
    active.add(key);
    const existing = db.prepare("SELECT * FROM observations WHERE connection_id=? AND download_id=?").get(connection.id, key) as { remaining: number; state: string; last_progress_at: string } | undefined;
    if (!existing || existing.remaining !== item.sizeleft || existing.state !== item.status) {
      db.prepare("INSERT INTO observations(connection_id,download_id,queue_id,remaining,state,last_progress_at,observed_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(connection_id,download_id) DO UPDATE SET queue_id=excluded.queue_id,remaining=excluded.remaining,state=excluded.state,last_progress_at=excluded.last_progress_at,observed_at=excluded.observed_at")
        .run(connection.id, key, item.id, item.sizeleft, item.status, now, now);
      continue;
    }
    db.prepare("UPDATE observations SET observed_at=?,queue_id=? WHERE connection_id=? AND download_id=?").run(now, item.id, connection.id, key);
    const timeout = item.protocol === "torrent" ? connection.torrent_timeout_min : connection.usenet_timeout_min;
    if (Date.now() - Date.parse(existing.last_progress_at) < timeout * 60_000) continue;
    const sameDownload = items.filter((other) => other.downloadId === key);
    const titleId = connection.kind === "sonarr" ? item.seriesId : item.movieId;
    const episodeIds = [...new Set(sameDownload.map((other) => other.episodeId).filter((id): id is number => typeof id === "number"))];
    if (!titleId || (connection.kind === "sonarr" && !episodeIds.length) || !item.title) {
      activity("stall", "review", `Cannot identify a targeted replacement for ${item.title || key}`, connection.id);
      continue;
    }
    const dedupeKey = `stall:${connection.id}:${key}:${existing.last_progress_at}`;
    createUniqueJob(dedupeKey, "stall", connection.id, undefined, { downloadId: key, queueId: item.id, remaining: item.sizeleft, titleId, episodeIds, sourceTitle: item.title });
  }
  const observed = db.prepare("SELECT download_id FROM observations WHERE connection_id=?").all(connection.id) as Array<{ download_id: string }>;
  for (const row of observed) if (!active.has(row.download_id)) db.prepare("DELETE FROM observations WHERE connection_id=? AND download_id=?").run(connection.id, row.download_id);
}

async function reconcile(connection: Connection) {
  const client = new ArrClient(connection);
  const since = connection.history_cursor || new Date(Date.now() - 10 * 60_000).toISOString();
  const imports = await client.recentImports(since);
  if (imports.length && (connection.on_import || connection.on_upgrade)) {
    const files = await client.files();
    for (const item of imports) {
      const upgrade = item.data?.isUpgrade;
      if (typeof upgrade === "boolean") {
        if (upgrade ? !connection.on_upgrade : !connection.on_import) continue;
      } else if (!connection.on_import || !connection.on_upgrade) {
        activity("media", "review", `History import ${item.id} could not be classified as import or upgrade`, connection.id);
        continue;
      }
      const titleId = connection.kind === "sonarr" ? item.seriesId : item.movieId;
      const matches = files.filter((file) => {
        if ((connection.kind === "sonarr" ? file.seriesId : file.movieId) !== titleId) return false;
        const paths = Object.values(item.data || {}).filter((value): value is string => typeof value === "string");
        return file.path && paths.some((path) => path === file.path || path.endsWith(file.relativePath || "\0"));
      });
      if (matches.length !== 1) continue;
      const file = matches[0];
      if (item.downloadId) db.prepare("INSERT OR REPLACE INTO provenance(connection_id,file_id,download_id,episode_ids,created_at) VALUES(?,?,?,?,?)")
        .run(connection.id, file.id, item.downloadId, JSON.stringify(item.episodeId ? [item.episodeId] : []), isoNow());
      createUniqueJob(`import:${connection.id}:${file.id}:${item.id}`, "media-file", connection.id, undefined, { fileId: file.id, isUpgrade: typeof upgrade === "boolean" ? upgrade : undefined });
    }
  }
  db.prepare("UPDATE connections SET history_cursor=? WHERE id=?").run(new Date(Date.now() - 60_000).toISOString(), connection.id);
}

async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    let idle = enabledConnections().length > 0;
    for (const connection of enabledConnections()) {
      try {
        const client = new ArrClient(connection);
        const items = await client.queue();
        if (items.length || await client.hasImportCommands()) idle = false;
        await pollStalls(connection, items);
        if (connection.scan_enabled && connection.next_scan_at && connection.next_scan_at <= isoNow()) {
          createJob("media-scan", connection.id);
          db.prepare("UPDATE connections SET next_scan_at=? WHERE id=?").run(new Date(Date.now() + connection.scan_interval_hours * 3600_000).toISOString(), connection.id);
        }
        if (Date.now() - lastReconcile > 5 * 60_000) await reconcile(connection);
      } catch (error) {
        idle = false;
        db.prepare("DELETE FROM observations WHERE connection_id=?").run(connection.id);
        log("warn", `Connection poll failed: ${String(error)}`, connection.id);
      }
    }
    if (Date.now() - lastReconcile > 5 * 60_000) lastReconcile = Date.now();
    idleSince = idle ? (idleSince ?? Date.now()) : null;
    for (const target of allTargets()) {
      if (!target.enabled || !target.next_run_at || target.next_run_at > isoNow()) continue;
      if (idleSince !== null && Date.now() - idleSince >= 30 * 60_000) {
        createJob("cleanup", undefined, target.id);
        db.prepare("UPDATE cleanup_targets SET next_run_at=? WHERE id=?").run(new Date(Date.now() + target.interval_hours * 3600_000).toISOString(), target.id);
      }
    }
    pruneLogs();
  } finally {
    ticking = false;
    void drainJobs();
  }
}

export function startWorker() {
  void tick();
  setInterval(() => void tick(), 2 * 60_000).unref();
  setInterval(() => void drainJobs(), 5_000).unref();
}

export function previewId(): string { return randomUUID(); }
export function observedIdleSince(): string | null { return idleSince === null ? null : new Date(idleSince).toISOString(); }
export function resetIdle() { idleSince = null; }
