import { iso6393 } from "iso-639-3";
import type { Connection, HistoryItem, MediaFile, PreviewRow } from "./types.ts";
import { ArrClient } from "./arr.ts";
import { db } from "./db.ts";

const languageIndex = new Map<string, string>();
for (const language of iso6393) {
  languageIndex.set(language.iso6393, language.iso6393);
  if (language.iso6391) languageIndex.set(language.iso6391, language.iso6393);
  if (language.iso6392B) languageIndex.set(language.iso6392B, language.iso6393);
  if (language.iso6392T) languageIndex.set(language.iso6392T, language.iso6393);
  languageIndex.set(language.name.toLowerCase(), language.iso6393);
}
languageIndex.set("und", "unknown");
languageIndex.set("undetermined", "unknown");
languageIndex.set("unknown", "unknown");
languageIndex.set("original", "unknown");
// These codes do not identify a specific audio language, so they cannot justify deletion.
for (const value of ["mul", "multiple languages", "mis", "uncoded languages", "zxx", "no linguistic content"]) languageIndex.set(value, "unknown");

export const languages = iso6393.filter((entry) => entry.type === "living").map((entry) => ({ code: entry.iso6393, name: entry.name })).sort((a, b) => a.name.localeCompare(b.name));

export function normalizeLanguage(value: string): string {
  const clean = value.trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  return languageIndex.get(clean) || "unknown";
}

export function audioLanguages(raw: string | null | undefined): string[] {
  if (!raw?.trim()) return [];
  return [...new Set(raw.split(/\s*[,;/|+]\s*/).filter(Boolean).map(normalizeLanguage))];
}

export function evaluateAudio(mode: "allow" | "block", selected: string[], audio: string[]): { status: "pass" | "fail" | "review"; reason: string } {
  if (!audio.length) return { status: "review", reason: "No analyzed audio language" };
  const set = new Set(selected);
  if (mode === "allow") {
    if (audio.some((value) => set.has(value))) return { status: "pass", reason: "Contains an allowed audio track" };
    if (audio.includes("unknown")) return { status: "review", reason: "An audio track has an unknown language" };
    return { status: "fail", reason: "No allowed audio track" };
  }
  if (audio.some((value) => set.has(value))) return { status: "fail", reason: "Contains a blocked audio track" };
  if (audio.includes("unknown")) return { status: "review", reason: "An audio track has an unknown language" };
  return { status: "pass", reason: "No blocked audio track" };
}

export function policyRevision(connection: Connection): string {
  return `${connection.policy_mode}:${connection.languages}`;
}

function eventType(item: HistoryItem): string { return String(item.eventType).toLowerCase(); }

export async function matchGrab(client: ArrClient, connection: Connection, file: MediaFile, episodeIds: number[]): Promise<{ historyId: number; sourceTitle: string } | undefined> {
  const titleId = connection.kind === "sonarr" ? file.seriesId : file.movieId;
  if (!titleId) return undefined;
  const history = await client.history(titleId);
  const provenance = db.prepare("SELECT download_id FROM provenance WHERE connection_id=? AND file_id=?").get(connection.id, file.id) as { download_id: string } | undefined;
  let downloadId = provenance?.download_id;
  if (!downloadId) {
    const imports = history.filter((item) => eventType(item) === "downloadfolderimported" && item.downloadId);
    const candidates = imports.filter((item) => {
      if (connection.kind === "sonarr" && item.episodeId && episodeIds.length && !episodeIds.includes(item.episodeId)) return false;
      const values = Object.values(item.data || {}).filter((value): value is string => typeof value === "string");
      const pathMatches = file.path && values.some((value) => value === file.path || value.endsWith(file.relativePath || "\0"));
      const timeMatches = file.dateAdded && item.date && Math.abs(Date.parse(file.dateAdded) - Date.parse(item.date)) < 5 * 60_000;
      return Boolean(pathMatches || timeMatches);
    });
    const ids = [...new Set(candidates.map((item) => item.downloadId))];
    if (ids.length === 1) downloadId = ids[0];
  }
  if (!downloadId) return undefined;
  const grabbed = history.filter((item) => eventType(item) === "grabbed" && item.downloadId === downloadId && item.sourceTitle);
  const unique = [...new Map(grabbed.map((item) => [item.sourceTitle, item])).values()];
  return unique.length === 1 ? { historyId: unique[0].id, sourceTitle: unique[0].sourceTitle! } : undefined;
}

export async function inspectFile(client: ArrClient, connection: Connection, file: MediaFile): Promise<PreviewRow> {
  const audio = audioLanguages(file.mediaInfo?.audioLanguages);
  const selected = JSON.parse(connection.languages) as string[];
  const evaluation = evaluateAudio(connection.policy_mode, selected, audio);
  const titleId = connection.kind === "sonarr" ? file.seriesId : file.movieId;
  const episodeIds = connection.kind === "sonarr" && file.seriesId ? await client.episodeIds(file.id, file.seriesId) : [];
  const row: PreviewRow = { connectionId: connection.id, file, titleId: titleId || 0, episodeIds, audio, ...evaluation, policyRevision: policyRevision(connection) };
  if (row.status === "fail") {
    const grab = await matchGrab(client, connection, file, episodeIds);
    if (grab) { row.historyId = grab.historyId; row.releaseTitle = grab.sourceTitle; }
    else { row.status = "review"; row.reason = "Exact grabbed release could not be identified"; }
  }
  return row;
}
