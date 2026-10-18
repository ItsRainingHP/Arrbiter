import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = await mkdtemp(join(tmpdir(), "arrbiter-integration-"));
const config = join(root, "config");
const cleanup = join(root, "cleanup");
await mkdir(config);
await mkdir(cleanup);
let app;
const mocks = [];

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}
async function body(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text ? JSON.parse(text) : {};
}
function json(response, value, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}
async function mockArr(kind, { extraFile = false, failFirstDelete = false, rejectNotification = false } = {}) {
  const id = kind === "sonarr" ? 10 : 40;
  const fileId = id + 1;
  const episodeId = id + 2;
  const historyId = id + 3;
  const downloadId = `${kind}-download`;
  const release = `${kind}.Japanese.Release`;
  const file = { id: fileId, [kind === "sonarr" ? "seriesId" : "movieId"]: id, path: `/library/${kind}.mkv`, relativePath: `${kind}.mkv`,
    size: 1000, dateAdded: "2026-10-14T00:00:00Z", mediaInfo: { audioLanguages: "Japanese" } };
  const secondFile = extraFile ? { ...file, id: fileId + 10, path: `/library/${kind}-second.mkv`, relativePath: `${kind}-second.mkv` } : null;
  const state = { present: true, secondPresent: extraFile, blocklisted: false, searches: 0, notification: null, steps: [] };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const path = url.pathname.replace("/api/v3", "");
      if (path === "/system/status") return json(response, { version: "fixture-1" });
      if (path === "/notification/schema") return json(response, [{ implementation: "Webhook", fields: [{ name: "url", value: "" }, { name: "method", value: 1 }, { name: "headers", value: [] }] }]);
      if (path === "/notification" && request.method === "POST") {
        if (rejectNotification) return json(response, { error: "Fixture rejected notification" }, 400);
        const notification = await body(request);
        const callback = notification.fields.find((field) => field.name === "url")?.value;
        const secret = notification.fields.find((field) => field.name === "headers")?.value?.[0]?.value;
        const test = await fetch(callback, { method: "POST", headers: { "X-Arrbiter-Token": secret, "Content-Type": "application/json" }, body: JSON.stringify({ eventType: "Test" }) });
        if (!test.ok) return json(response, { error: `Webhook test returned ${test.status}` }, 500);
        state.notification = notification;
        return json(response, { id: kind === "sonarr" ? 91 : 92 });
      }
      if (path === (kind === "sonarr" ? "/series" : "/movie")) return json(response, [{ id }]);
      if (path === (kind === "sonarr" ? "/episodefile" : "/moviefile")) {
        if (!url.searchParams.has(kind === "sonarr" ? "seriesId" : "movieId")) return json(response, { error: "Title ID required" }, 400);
        return json(response, [...(state.present ? [file] : []), ...(state.secondPresent ? [secondFile] : [])]);
      }
      const fileRoute = `/${kind === "sonarr" ? "episodefile" : "moviefile"}/`;
      if (path === `${fileRoute}${fileId}` || (secondFile && path === `${fileRoute}${secondFile.id}`)) {
        const first = path === `${fileRoute}${fileId}`;
        if (request.method === "GET") return first ? (state.present ? json(response, file) : json(response, { error: "Missing" }, 404))
          : (state.secondPresent ? json(response, secondFile) : json(response, { error: "Missing" }, 404));
        if (request.method === "DELETE") {
          if (first && failFirstDelete) { state.steps.push("delete-error"); return json(response, { error: "Fixture deletion failed" }, 500); }
          state.steps.push("delete");
          if (first) state.present = false; else state.secondPresent = false;
          return json(response, {});
        }
      }
      if (path === "/episode") return json(response, [{ id: episodeId, episodeFileId: fileId }]);
      if (path === (kind === "sonarr" ? "/history/series" : "/history/movie")) return json(response, [
        { id: historyId, eventType: "grabbed", downloadId, sourceTitle: release },
        { id: historyId + 1, eventType: "downloadFolderImported", downloadId, data: { importedPath: file.path } },
        ...(secondFile ? [
          { id: historyId + 10, eventType: "grabbed", downloadId: `${downloadId}-second`, sourceTitle: `${release}.second` },
          { id: historyId + 11, eventType: "downloadFolderImported", downloadId: `${downloadId}-second`, data: { importedPath: secondFile.path } },
        ] : []),
      ]);
      if (path === "/history/since") return json(response, []);
      if ((path === `/history/failed/${historyId}` || (secondFile && path === `/history/failed/${historyId + 10}`)) && request.method === "POST") {
        state.steps.push("blocklist"); state.blocklisted = true; return json(response, {});
      }
      if (path === "/blocklist") {
        const records = state.blocklisted ? [
          { [kind === "sonarr" ? "seriesId" : "movieId"]: id, sourceTitle: release },
          ...(secondFile ? [{ [kind === "sonarr" ? "seriesId" : "movieId"]: id, sourceTitle: `${release}.second` }] : []),
        ] : [];
        return json(response, { records, totalRecords: records.length });
      }
      if (path === "/queue") return json(response, { records: [], totalRecords: 0 });
      if (path === "/command" && request.method === "GET") return json(response, []);
      if (path === "/command" && request.method === "POST") {
        const command = await body(request);
        if (kind === "sonarr" && (command.name !== "EpisodeSearch" || command.episodeIds?.[0] !== episodeId)) return json(response, { error: "Wrong search" }, 400);
        if (kind === "radarr" && (command.name !== "MoviesSearch" || command.movieIds?.[0] !== id)) return json(response, { error: "Wrong search" }, 400);
        state.steps.push("search"); state.searches++; return json(response, { id: 1 });
      }
      return json(response, { error: `Unexpected ${request.method} ${path}` }, 404);
    } catch (error) { return json(response, { error: String(error) }, 500); }
  });
  const port = await listen(server);
  mocks.push(server);
  return { kind, id, fileId, episodeId, downloadId, release, file, state, url: `http://127.0.0.1:${port}` };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, label, timeout = 15_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { const result = await check(); if (result) return result; } catch { /* Still starting. */ }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  const sonarr = await mockArr("sonarr");
  const radarr = await mockArr("radarr");
  const portServer = createServer();
  const appPort = await listen(portServer);
  await new Promise((resolve) => portServer.close(resolve));
  const webhookPortServer = createServer();
  const webhookPort = await listen(webhookPortServer);
  await new Promise((resolve) => webhookPortServer.close(resolve));
  const base = `http://127.0.0.1:${appPort}`;
  const callbackBase = `http://127.0.0.1:${webhookPort}`;
  let stderr = "";
  app = spawn(process.execPath, ["dist/server/main.js"], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: "production", ARRBITER_PORT: String(appPort), ARRBITER_WEBHOOK_PORT: String(webhookPort), ARRBITER_CONFIG_DIR: config, ARRBITER_CLEANUP_ROOT: cleanup },
    stdio: ["ignore", "pipe", "pipe"],
  });
  app.stdout.on("data", () => {});
  app.stderr.on("data", (chunk) => { stderr += chunk; });
  await waitFor(async () => (await fetch(base + "/api/health")).ok, "Arrbiter startup");
  if ((await fetch(callbackBase + "/api/auth/status")).status !== 404) throw new Error("Webhook listener exposed the login API");
  const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "arrbiter" }) });
  if (!login.ok) throw new Error(`Default login failed: ${login.status}`);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  const loginData = await login.json();
  if (!loginData.mustChangeCredentials) throw new Error("Default credentials warning is missing");
  const csrf = loginData.csrf;
  async function api(path, method = "GET", data) {
    const response = await fetch(base + "/api" + path, { method, headers: { Cookie: cookie, "X-CSRF-Token": csrf, ...(data === undefined ? {} : { "Content-Type": "application/json" }) }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  }
  const changed = await api("/auth/credentials", "POST", {
    currentPassword: "arrbiter", username: "integration", password: "integration-password-123",
  });
  if (changed.username !== "integration" || changed.mustChangeCredentials) throw new Error("Credentials were not updated");
  const status = await api("/auth/status");
  if (status.username !== "integration" || status.mustChangeCredentials) throw new Error("Default credentials warning did not clear");
  const oldLogin = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "arrbiter" }) });
  if (oldLogin.status !== 401) throw new Error("Default login still works after changing credentials");
  const updatedLogin = await fetch(base + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "integration", password: "integration-password-123" }) });
  if (!updatedLogin.ok || (await updatedLogin.json()).mustChangeCredentials) throw new Error("Updated login failed");
  for (const mock of [sonarr, radarr]) {
    const saved = await api("/connections", "POST", {
      kind: mock.kind, name: mock.kind, url: mock.url, apiKey: "fixture-key", callbackUrl: callbackBase,
      enabled: true, policyMode: "allow", languages: ["eng"], onImport: true, onUpgrade: true,
      scanEnabled: false, scanIntervalHours: 24, stallEnabled: false, torrentTimeoutMin: 1440, usenetTimeoutMin: 360,
    });
    if (!saved.enabled || !mock.state.notification) throw new Error(`${mock.kind} connection was not activated with a webhook`);
    const secret = mock.state.notification.fields.find((field) => field.name === "headers")?.value?.[0]?.value;
    if (!secret) throw new Error(`${mock.kind} webhook token missing`);
    const event = { eventType: "Download", isUpgrade: false, downloadId: mock.downloadId,
      [mock.kind === "sonarr" ? "episodeFile" : "movieFile"]: mock.file, episodes: [{ id: mock.episodeId }] };
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${callbackBase}/api/webhooks/${saved.id}`, { method: "POST", headers: { "X-Arrbiter-Token": secret, "Content-Type": "application/json" }, body: JSON.stringify(event) });
      if (response.status !== 202) throw new Error(`${mock.kind} webhook failed: ${response.status}`);
    }
    if ((await fetch(`${callbackBase}/api/webhooks/${saved.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ eventType: "Test" }) })).status !== 401)
      throw new Error(`${mock.kind} webhook accepted an unauthenticated test`);
    await waitFor(() => !mock.state.present && mock.state.searches === 1, `${mock.kind} remediation`);
    if (mock.state.steps.join(",") !== "blocklist,delete,search") throw new Error(`${mock.kind} action order was ${mock.state.steps.join(",")}`);
  }
  const beforeFailedSave = (await api("/connections")).length;
  const failingSonarr = await mockArr("sonarr", { rejectNotification: true });
  const failingSettings = {
    kind: "sonarr", name: "failing-sonarr", url: failingSonarr.url, apiKey: "fixture-key", callbackUrl: callbackBase,
    enabled: true, policyMode: "allow", languages: ["eng"], onImport: true, onUpgrade: true,
    scanEnabled: false, scanIntervalHours: 24, stallEnabled: false, torrentTimeoutMin: 1440, usenetTimeoutMin: 360,
  };
  try { await api("/connections", "POST", failingSettings); throw new Error("Rejected webhook was accepted"); }
  catch (error) { if (!String(error).includes("Connection was not saved")) throw error; }
  if ((await api("/connections")).length !== beforeFailedSave) throw new Error("Failed active save left a disabled duplicate connection");
  try { await api("/connections/test", "POST", { ...failingSettings, url: "http://192.168.50.6:8989", callbackUrl: "http://localhost:8787" }); throw new Error("Invalid callback passed connection test"); }
  catch (error) { if (!String(error).includes("callback URL uses localhost")) throw error; }
  if ((await api("/connections")).length !== beforeFailedSave) throw new Error("Invalid callback created a connection");
  const manual = await mockArr("radarr");
  const manualConnection = await api("/connections", "POST", {
    kind: "radarr", name: "manual-radarr", url: manual.url, apiKey: "fixture-key", callbackUrl: "",
    enabled: false, policyMode: "allow", languages: ["eng"], onImport: false, onUpgrade: false,
    scanEnabled: false, scanIntervalHours: 24, stallEnabled: false, torrentTimeoutMin: 1440, usenetTimeoutMin: 360,
  });
  if (manualConnection.enabled) throw new Error("Manual fixture unexpectedly activated");
  const manualPreview = await api(`/connections/${manualConnection.id}/preview`, "POST");
  if (manualPreview.rows.length !== 1 || manualPreview.rows[0].status !== "fail") throw new Error("Disabled connection did not preview a verified failure");
  const manualApply = await api(`/previews/${manualPreview.id}/apply`, "POST");
  const manualJob = await waitFor(async () => {
    const current = await api(`/jobs/${manualApply.jobId}`);
    return current.state === "done" || current.state === "failed" ? current : null;
  }, "manual apply on disabled connection");
  if (manualJob.state !== "done" || manualJob.total !== 1 || manualJob.completed !== 1 || manualJob.succeeded !== 1 || manualJob.failed !== 0)
    throw new Error(`Manual apply result was ${JSON.stringify(manualJob)}`);
  if (manual.state.steps.join(",") !== "blocklist,delete,search") throw new Error("Manual Radarr actions did not complete");

  const partial = await mockArr("radarr", { extraFile: true, failFirstDelete: true });
  const partialConnection = await api("/connections", "POST", {
    kind: "radarr", name: "partial-radarr", url: partial.url, apiKey: "fixture-key", callbackUrl: base,
    enabled: false, policyMode: "allow", languages: ["eng"], onImport: false, onUpgrade: false,
    scanEnabled: false, scanIntervalHours: 24, stallEnabled: false, torrentTimeoutMin: 1440, usenetTimeoutMin: 360,
  });
  const partialPreview = await api(`/connections/${partialConnection.id}/preview`, "POST");
  if (partialPreview.rows.length !== 2 || partialPreview.rows.some((row) => row.status !== "fail")) throw new Error("Partial fixture did not preview two failures");
  const partialApply = await api(`/previews/${partialPreview.id}/apply`, "POST");
  const partialJob = await waitFor(async () => {
    const current = await api(`/jobs/${partialApply.jobId}`);
    return current.state === "done" || current.state === "failed" ? current : null;
  }, "partial manual apply");
  if (partialJob.state !== "failed" || partialJob.total !== 2 || partialJob.completed !== 2 || partialJob.failed !== 1 || partialJob.succeeded !== 1)
    throw new Error(`Partial apply result was ${JSON.stringify(partialJob)}`);
  if (!partial.state.present || partial.state.secondPresent || partial.state.searches !== 1) throw new Error("Partial apply did not continue safely to the next file");
  const jobs = await api("/jobs");
  if (jobs.filter((job) => job.kind === "media-file").length !== 2 || jobs.some((job) => job.kind === "media-file" && job.state === "failed")) throw new Error("Duplicate or failed media jobs");
  const exportResponse = await fetch(base + "/api/logs/export?format=jsonl", { headers: { Cookie: cookie } });
  if (!exportResponse.ok || !(await exportResponse.text()).includes("requested replacement")) throw new Error("Log export failed");
  console.log("Integration passed: isolated webhook listener, Sonarr and Radarr activation tests, manual apply on disabled Radarr, per-file partial results, exact blocklist/delete/search, duplicate suppression, and logs.");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  app?.kill();
  for (const server of mocks) await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
