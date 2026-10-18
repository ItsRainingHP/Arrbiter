import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rename, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CleanupTarget, Connection, MediaFile, QueueItem } from "./types.ts";

const base = await mkdtemp(join(tmpdir(), "arrbiter-tests-"));
process.env.ARRBITER_CONFIG_DIR = join(base, "config");
process.env.ARRBITER_CLEANUP_ROOT = join(base, "cleanup");
await mkdir(process.env.ARRBITER_CLEANUP_ROOT);

const { db, encrypt, markDedupe } = await import("./db.ts");
const { log } = await import("./logs.ts");
const { ArrClient } = await import("./arr.ts");
const { audioLanguages, evaluateAudio, inspectFile } = await import("./policy.ts");
const { snapshotFolder, applyCleanup, validateTargetPath } = await import("./cleanup.ts");
const { pollStalls, runStall, remediateMedia, allInstancesIdle } = await import("./worker.ts");

const connection = (id: number, kind: "sonarr" | "radarr" = "sonarr"): Connection => ({
  id, kind, name: `Test ${id}`, url: "http://127.0.0.1:9999", api_key_enc: encrypt("test-key"),
  callback_url: "http://arrbiter:8787", webhook_secret: "secret", webhook_notification_id: null,
  enabled: 1, policy_mode: "allow", languages: '["eng"]', scan_enabled: 0, scan_interval_hours: 24,
  on_import: 1, on_upgrade: 1, stall_enabled: 1, torrent_timeout_min: 30, usenet_timeout_min: 30,
  next_scan_at: null, history_cursor: null,
});

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(() => db.close());

describe("audio decisions and source identity", () => {
  it("handles allowlists, blocklists, multiple tracks, and unknown audio", () => {
    expect(audioLanguages("English, Japanese")).toEqual(["eng", "jpn"]);
    expect(audioLanguages("mul, mis, zxx")).toEqual(["unknown"]);
    expect(evaluateAudio("allow", ["eng"], ["jpn", "eng"]).status).toBe("pass");
    expect(evaluateAudio("allow", ["eng"], ["jpn"]).status).toBe("fail");
    expect(evaluateAudio("block", ["eng"], ["eng", "jpn"]).status).toBe("fail");
    expect(evaluateAudio("block", ["eng"], ["jpn"]).status).toBe("pass");
    expect(evaluateAudio("allow", ["eng"], ["unknown"]).status).toBe("review");
    expect(evaluateAudio("block", ["eng"], []).status).toBe("review");
  });

  it("keeps a failing file in review without one exact grabbed release", async () => {
    const file: MediaFile = { id: 42, seriesId: 8, path: "/media/show.mkv", dateAdded: new Date().toISOString(), mediaInfo: { audioLanguages: "Japanese" } };
    const client = {
      episodeIds: async () => [24],
      history: async () => [
        { id: 1, eventType: "downloadFolderImported", downloadId: "abc", episodeId: 24, date: file.dateAdded },
        { id: 2, eventType: "grabbed", downloadId: "abc", sourceTitle: "Release A" },
        { id: 3, eventType: "grabbed", downloadId: "abc", sourceTitle: "Release B" },
      ],
    } as unknown as InstanceType<typeof ArrClient>;
    const row = await inspectFile(client, connection(42), file);
    expect(row.status).toBe("review");
    expect(row.historyId).toBeUndefined();
  });

  it("ties an exact grab to a proven download ID", async () => {
    db.prepare("INSERT INTO provenance(connection_id,file_id,download_id,episode_ids,created_at) VALUES(?,?,?,?,?)").run(43, 7, "download-7", "[]", new Date().toISOString());
    const file: MediaFile = { id: 7, seriesId: 9, mediaInfo: { audioLanguages: "Japanese" } };
    const client = { episodeIds: async () => [11], history: async () => [
      { id: 9, eventType: "grabbed", downloadId: "download-7", sourceTitle: "Exact.Release" },
      { id: 10, eventType: "grabbed", downloadId: "another", sourceTitle: "Other.Release" },
    ] } as unknown as InstanceType<typeof ArrClient>;
    const row = await inspectFile(client, connection(43), file);
    expect(row.status).toBe("fail");
    expect(row.historyId).toBe(9);
    expect(row.releaseTitle).toBe("Exact.Release");
  });
});

describe("Sonarr and Radarr API contract", () => {
  it.each(["sonarr", "radarr"] as const)("lists %s files by title ID", async (kind) => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", async (input: URL) => {
      const path = new URL(input).pathname + new URL(input).search;
      paths.push(path);
      if (path.endsWith(kind === "sonarr" ? "/series" : "/movie")) return Response.json([{ id: 1 }, { id: 2 }]);
      return Response.json([{ id: Number(new URL(input).searchParams.values().next().value) }]);
    });
    const files = await new ArrClient(connection(1, kind)).files();
    expect(files.map((file) => file.id)).toEqual([1, 2]);
    expect(paths).toContain(`/api/v3/${kind === "sonarr" ? "episodefile?seriesId" : "moviefile?movieId"}=1`);
  });

  it("removes a queue item with client removal, blocklist, and suppressed retry", async () => {
    let called = "";
    vi.stubGlobal("fetch", async (input: URL) => { called = String(input); return new Response(null, { status: 204 }); });
    await new ArrClient(connection(1)).removeQueue(123);
    expect(called).toContain("/queue/123?removeFromClient=true&blocklist=true&skipRedownload=true");
  });
});

describe("disposable folder cleanup", () => {
  const target = (path: string): CleanupTarget => ({ id: 1, name: "Disposable", path, interval_hours: 24, enabled: 1, next_run_at: null });

  it("leaves changed and newly created entries and retains the target folder", async () => {
    const path = join(base, "cleanup", "changed");
    await mkdir(path);
    await writeFile(join(path, "old.txt"), "old");
    const manifest = await snapshotFolder(target(path));
    await writeFile(join(path, "old.txt"), "changed content");
    await writeFile(join(path, "new.txt"), "new");
    const result = await applyCleanup(target(path), manifest, async () => true);
    expect(result).toEqual({ deleted: 0, skipped: 1 });
    expect(await readFile(join(path, "old.txt"), "utf8")).toBe("changed content");
    expect(await stat(join(path, "new.txt"))).toBeTruthy();
    expect(await stat(path)).toBeTruthy();
  });

  it("stops immediately if activity appears", async () => {
    const path = join(base, "cleanup", "busy");
    await mkdir(path);
    await writeFile(join(path, "keep.txt"), "data");
    const manifest = await snapshotFolder(target(path));
    await expect(applyCleanup(target(path), manifest, async () => false)).rejects.toThrow("Activity changed");
    expect(await readFile(join(path, "keep.txt"), "utf8")).toBe("data");
  });

  it("rejects overlapping folders and refuses a swapped parent symlink", async () => {
    const path = join(base, "cleanup", "parent");
    const child = join(path, "nested");
    await mkdir(child, { recursive: true });
    await writeFile(join(child, "file.txt"), "data");
    await expect(validateTargetPath(child, [path])).rejects.toThrow("overlap");
    const manifest = await snapshotFolder(target(path));
    const moved = join(path, "moved");
    await rename(child, moved);
    try { await symlink(moved, child, "dir"); } catch { return; }
    const result = await applyCleanup(target(path), manifest, async () => true);
    expect(result.deleted).toBe(0);
    expect(await readFile(join(moved, "file.txt"), "utf8")).toBe("data");
  });
});

describe("stalled download observations", () => {
  const item = (changes: Partial<QueueItem> = {}): QueueItem => ({
    id: 501, downloadId: "hash-501", protocol: "torrent", status: "downloading", trackedDownloadState: "downloading",
    size: 1000, sizeleft: 400, seriesId: 12, episodeId: 13, title: "Release.501", ...changes,
  });

  it("requires the full interval and resets on progress or pause", async () => {
    const c = connection(501);
    await pollStalls(c, [item()]);
    let observation = db.prepare("SELECT * FROM observations WHERE connection_id=501").get() as { remaining: number };
    expect(observation.remaining).toBe(400);
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='stall'").get() as { n: number }).n).toBe(0);
    db.prepare("UPDATE observations SET last_progress_at=? WHERE connection_id=501").run(new Date(Date.now() - 31 * 60_000).toISOString());
    await pollStalls(c, [item({ sizeleft: 300 })]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='stall'").get() as { n: number }).n).toBe(0);
    await pollStalls(c, [item({ status: "paused" })]);
    expect(db.prepare("SELECT * FROM observations WHERE connection_id=501").get()).toBeUndefined();
    await pollStalls(c, [item({ sizeleft: undefined })]);
    expect(db.prepare("SELECT * FROM observations WHERE connection_id=501").get()).toBeUndefined();
    await pollStalls(c, [item({ protocol: "usenet" })]);
    db.prepare("UPDATE observations SET last_progress_at=? WHERE connection_id=501").run(new Date(Date.now() - 31 * 60_000).toISOString());
    await pollStalls(c, [item({ protocol: "usenet" })]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='stall'").get() as { n: number }).n).toBe(1);
  });

  it("holds a shared download before removal", async () => {
    const first = connection(601);
    const second = connection(602);
    for (const c of [first, second]) db.prepare("INSERT INTO connections(id,kind,name,url,api_key_enc,callback_url,webhook_secret,enabled,languages) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(c.id, c.kind, c.name, c.url, c.api_key_enc, c.callback_url, c.webhook_secret, 1, c.languages);
    db.prepare("INSERT INTO observations(connection_id,download_id,queue_id,remaining,state,last_progress_at,observed_at) VALUES(?,?,?,?,?,?,?)")
      .run(601, "shared", 10, 400, "downloading", new Date(Date.now() - 31 * 60_000).toISOString(), new Date().toISOString());
    let removed = false;
    const remove = vi.spyOn(ArrClient.prototype, "removeQueue").mockImplementation(async () => { removed = true; });
    vi.spyOn(ArrClient.prototype, "queue").mockImplementation(async function (this: InstanceType<typeof ArrClient>) {
      return this.connection.id === 601 ? (removed ? [] : [item({ id: 10, downloadId: "shared" })]) : [item({ id: 11, downloadId: "shared" })];
    });
    await expect(runStall(first, 1, { downloadId: "shared", queueId: 10, remaining: 400, titleId: 12, episodeIds: [13], sourceTitle: "Release.501" })).rejects.toThrow("Another connected instance");
    expect(remove).not.toHaveBeenCalled();
    db.prepare("UPDATE connections SET enabled=0 WHERE id=602").run();
    vi.spyOn(ArrClient.prototype, "blocklisted").mockResolvedValue(true);
    vi.spyOn(ArrClient.prototype, "searchQueued").mockResolvedValue(false);
    const search = vi.spyOn(ArrClient.prototype, "search").mockResolvedValue();
    await runStall(first, 1, { downloadId: "shared", queueId: 10, remaining: 400, titleId: 12, episodeIds: [13], sourceTitle: "Release.501" });
    expect(remove).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(12, [13]);
    expect(db.prepare("SELECT * FROM observations WHERE connection_id=601").get()).toBeUndefined();
  });

  it("withholds replacement search when queue removal is not confirmed", async () => {
    const c = connection(801);
    db.prepare("INSERT INTO connections(id,kind,name,url,api_key_enc,callback_url,webhook_secret,enabled,languages) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(c.id, c.kind, c.name, c.url, c.api_key_enc, c.callback_url, c.webhook_secret, 1, c.languages);
    db.prepare("INSERT INTO observations(connection_id,download_id,queue_id,remaining,state,last_progress_at,observed_at) VALUES(?,?,?,?,?,?,?)")
      .run(801, "stuck", 801, 400, "downloading", new Date(Date.now() - 31 * 60_000).toISOString(), new Date().toISOString());
    vi.spyOn(ArrClient.prototype, "queue").mockImplementation(async function (this: InstanceType<typeof ArrClient>) {
      return this.connection.id === 801 ? [item({ id: 801, downloadId: "stuck" })] : [];
    });
    const remove = vi.spyOn(ArrClient.prototype, "removeQueue").mockResolvedValue();
    const search = vi.spyOn(ArrClient.prototype, "search").mockResolvedValue();
    vi.useFakeTimers();
    const action = runStall(c, 1, { downloadId: "stuck", queueId: 801, remaining: 400, titleId: 12, episodeIds: [13], sourceTitle: "Release.501" });
    const rejection = expect(action).rejects.toThrow("removal could not be confirmed");
    await vi.runAllTimersAsync();
    await rejection;
    expect(remove).toHaveBeenCalledOnce();
    expect(search).not.toHaveBeenCalled();
  });
});

describe("media remediation and idle safety", () => {
  const c = connection(701);
  const original: MediaFile = { id: 70, seriesId: 17, path: "/media/episode.mkv", size: 100, dateAdded: "2026-01-01T00:00:00Z", mediaInfo: { audioLanguages: "Japanese" } };
  const row = { connectionId: 701, file: original, titleId: 17, episodeIds: [71], audio: ["jpn"], status: "fail" as const,
    reason: "No allowed audio track", policyRevision: 'allow:["eng"]', historyId: 72, releaseTitle: "Exact.Release" };
  beforeAll(() => {
    db.prepare("INSERT INTO connections(id,kind,name,url,api_key_enc,callback_url,webhook_secret,enabled,languages) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(c.id, c.kind, c.name, c.url, c.api_key_enc, c.callback_url, c.webhook_secret, 1, c.languages);
    db.prepare("INSERT INTO provenance(connection_id,file_id,download_id,episode_ids,created_at) VALUES(?,?,?,?,?)")
      .run(701, 70, "exact-download", "[71]", new Date().toISOString());
  });

  it("does not blocklist or delete a changed library file", async () => {
    vi.spyOn(ArrClient.prototype, "file").mockResolvedValue({ ...original, size: 101 });
    const fail = vi.spyOn(ArrClient.prototype, "markFailed").mockResolvedValue(undefined);
    const del = vi.spyOn(ArrClient.prototype, "deleteFile").mockResolvedValue();
    await expect(remediateMedia(row, 2)).rejects.toThrow("Media file changed");
    expect(fail).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("blocks the exact grab before deleting and requests one targeted search", async () => {
    const order: string[] = [];
    vi.spyOn(ArrClient.prototype, "file").mockResolvedValue(original);
    vi.spyOn(ArrClient.prototype, "episodeIds").mockResolvedValue([71]);
    vi.spyOn(ArrClient.prototype, "history").mockResolvedValue([{ id: 72, eventType: "grabbed", downloadId: "exact-download", sourceTitle: "Exact.Release" }]);
    vi.spyOn(ArrClient.prototype, "markFailed").mockImplementation(async () => { order.push("failed"); });
    vi.spyOn(ArrClient.prototype, "blocklisted").mockImplementation(async () => { order.push("confirmed"); return true; });
    vi.spyOn(ArrClient.prototype, "deleteFile").mockImplementation(async () => { order.push("deleted"); });
    vi.spyOn(ArrClient.prototype, "searchQueued").mockResolvedValue(false);
    vi.spyOn(ArrClient.prototype, "search").mockImplementation(async () => { order.push("searched"); });
    await remediateMedia(row, 3);
    expect(order).toEqual(["failed", "confirmed", "deleted", "searched"]);
  });

  it("holds cleanup for a pending import or an unavailable connection", async () => {
    vi.spyOn(ArrClient.prototype, "queue").mockResolvedValue([]);
    vi.spyOn(ArrClient.prototype, "hasImportCommands").mockResolvedValue(true);
    expect(await allInstancesIdle()).toBe(false);
    vi.spyOn(ArrClient.prototype, "hasImportCommands").mockRejectedValue(new Error("offline"));
    expect(await allInstancesIdle()).toBe(false);
  });
});

describe("event and log hygiene", () => {
  it("deduplicates repeated webhook identities", () => {
    expect(markDedupe("webhook:1:2:download:download")).toBe(true);
    expect(markDedupe("webhook:1:2:download:download")).toBe(false);
  });

  it("redacts credentials from stored and streamed log records", () => {
    const row = log("warn", "API key: sensitive-value token=another-value", undefined, undefined, { password: "hidden", nested: { apiKey: "secret" } });
    expect(row.message).not.toContain("sensitive-value");
    expect(JSON.stringify(row.details)).not.toContain("hidden");
    expect(JSON.stringify(row.details)).not.toContain("secret");
    const stored = db.prepare("SELECT message,details FROM logs WHERE id=?").get(row.id) as { message: string; details: string };
    expect(stored.message).toContain("[redacted]");
    expect(stored.details).not.toContain("hidden");
  });
});
