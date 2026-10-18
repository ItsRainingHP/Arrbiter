import { decrypt } from "./db.ts";
import type { Connection, HistoryItem, MediaFile, QueueItem } from "./types.ts";

export class ArrClient {
  constructor(public connection: Connection) {}

  async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const base = new URL(this.connection.url);
    if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Invalid connection URL");
    const prefix = base.pathname.replace(/\/$/, "");
    const url = new URL(base.origin + prefix + "/api/v3" + route);
    const response = await fetch(url, {
      method,
      headers: { "X-Api-Key": decrypt(this.connection.api_key_enc), Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${this.connection.kind} API ${method} ${route.split("?")[0]} returned ${response.status}`);
    if (response.status === 204) return undefined as T;
    const raw = await response.text();
    return raw ? JSON.parse(raw) as T : undefined as T;
  }

  test(): Promise<{ version?: string }> { return this.request("GET", "/system/status"); }

  async queue(): Promise<QueueItem[]> {
    const items: QueueItem[] = [];
    let page = 1;
    while (true) {
      const unknown = this.connection.kind === "sonarr" ? "includeUnknownSeriesItems" : "includeUnknownMovieItems";
      const data = await this.request<{ records: QueueItem[]; totalRecords: number }>("GET", `/queue?page=${page}&pageSize=250&${unknown}=true`);
      items.push(...(data.records || []));
      if (items.length >= data.totalRecords || !data.records?.length) break;
      page++;
      if (page > 100) throw new Error("Queue pagination exceeded safety limit");
    }
    return items;
  }

  async hasImportCommands(): Promise<boolean> {
    const commands = await this.request<Array<{ name?: string; status?: string }>>("GET", "/command");
    return commands.some((command) => /import|download/i.test(command.name || "") && /queued|started|running/i.test(command.status || ""));
  }

  async files(): Promise<MediaFile[]> {
    const titles = await this.request<Array<{ id: number }>>("GET", this.connection.kind === "sonarr" ? "/series" : "/movie");
    const route = this.connection.kind === "sonarr" ? "/episodefile?seriesId=" : "/moviefile?movieId=";
    const files: MediaFile[] = [];
    // Both APIs require a title ID when listing files. Keep a small request fan-out.
    for (let offset = 0; offset < titles.length; offset += 5) {
      const groups = await Promise.all(titles.slice(offset, offset + 5).map((title) => this.request<MediaFile[]>("GET", route + title.id)));
      files.push(...groups.flat());
    }
    return files;
  }

  file(id: number): Promise<MediaFile> {
    return this.request("GET", `${this.connection.kind === "sonarr" ? "/episodefile" : "/moviefile"}/${id}`);
  }

  deleteFile(id: number): Promise<void> {
    return this.request("DELETE", `${this.connection.kind === "sonarr" ? "/episodefile" : "/moviefile"}/${id}`);
  }

  history(titleId: number): Promise<HistoryItem[]> {
    return this.request("GET", this.connection.kind === "sonarr" ? `/history/series?seriesId=${titleId}` : `/history/movie?movieId=${titleId}`);
  }

  async recentImports(since: string): Promise<HistoryItem[]> {
    const data = await this.request<HistoryItem[]>("GET", `/history/since?date=${encodeURIComponent(since)}`);
    return data.filter((item) => /import/i.test(String(item.eventType)) || item.eventType === 3);
  }

  async episodeIds(fileId: number, seriesId: number): Promise<number[]> {
    const episodes = await this.request<Array<{ id: number; episodeFileId?: number }>>("GET", `/episode?seriesId=${seriesId}`);
    return episodes.filter((episode) => episode.episodeFileId === fileId).map((episode) => episode.id);
  }

  markFailed(historyId: number): Promise<unknown> { return this.request("POST", `/history/failed/${historyId}`); }

  async blocklisted(titleId: number, sourceTitle: string): Promise<boolean> {
    let page = 1;
    while (page <= 20) {
      const data = await this.request<{ records: Array<{ seriesId?: number; movieId?: number; sourceTitle?: string }>; totalRecords: number }>("GET", `/blocklist?page=${page}&pageSize=250`);
      if (data.records.some((item) => (this.connection.kind === "sonarr" ? item.seriesId : item.movieId) === titleId && item.sourceTitle === sourceTitle)) return true;
      if (page * 250 >= data.totalRecords || !data.records.length) return false;
      page++;
    }
    return false;
  }

  removeQueue(id: number): Promise<void> {
    return this.request("DELETE", `/queue/${id}?removeFromClient=true&blocklist=true&skipRedownload=true`);
  }

  async search(titleId: number, episodeIds: number[]): Promise<void> {
    const body = this.connection.kind === "sonarr"
      ? { name: "EpisodeSearch", episodeIds }
      : { name: "MoviesSearch", movieIds: [titleId] };
    await this.request("POST", "/command", body);
  }

  async searchQueued(titleId: number, episodeIds: number[]): Promise<boolean> {
    const commands = await this.request<Array<{ name?: string; status?: string; body?: Record<string, unknown> }>>("GET", "/command");
    return commands.some((command) => {
      if (!/queued|started|running/i.test(command.status || "")) return false;
      if (this.connection.kind === "radarr") return /moviessearch/i.test(command.name || "") && Array.isArray(command.body?.movieIds) && command.body.movieIds.includes(titleId);
      return /episodesearch/i.test(command.name || "") && Array.isArray(command.body?.episodeIds) && episodeIds.every((id) => (command.body?.episodeIds as number[]).includes(id));
    });
  }

  async registerWebhook(existingId?: number | null): Promise<number> {
    const schemas = await this.request<Array<Record<string, unknown>>>("GET", "/notification/schema");
    const schema = schemas.find((item) => item.implementation === "Webhook");
    if (!schema) throw new Error("This instance has no Webhook notification schema");
    const url = this.connection.callback_url.replace(/\/$/, "") + `/api/webhooks/${this.connection.id}`;
    const fields = (schema.fields as Array<{ name: string; value?: unknown }>).map((field) => ({
      ...field,
      value: field.name === "url" ? url : field.name === "method" ? 1 : field.name === "headers" ? [{ key: "X-Arrbiter-Token", value: this.connection.webhook_secret }] : field.value,
    }));
    const body = {
      ...schema, id: existingId || 0, name: `Arrbiter ${this.connection.id}`, fields,
      onGrab: false, onDownload: Boolean(this.connection.on_import), onUpgrade: Boolean(this.connection.on_upgrade), onImportComplete: false,
      onRename: false, onSeriesAdd: false, onMovieAdded: false,
    };
    const saved = await this.request<{ id: number }>(existingId ? "PUT" : "POST", existingId ? `/notification/${existingId}` : "/notification", body);
    return saved.id;
  }
}
