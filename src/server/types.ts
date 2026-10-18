export type ArrKind = "sonarr" | "radarr";
export type PolicyMode = "allow" | "block";

export interface Connection {
  id: number;
  kind: ArrKind;
  name: string;
  url: string;
  api_key_enc: string;
  callback_url: string;
  webhook_secret: string;
  webhook_notification_id: number | null;
  enabled: number;
  policy_mode: PolicyMode;
  languages: string;
  scan_enabled: number;
  scan_interval_hours: number;
  on_import: number;
  on_upgrade: number;
  stall_enabled: number;
  torrent_timeout_min: number;
  usenet_timeout_min: number;
  next_scan_at: string | null;
  history_cursor: string | null;
}

export interface CleanupTarget {
  id: number;
  name: string;
  path: string;
  interval_hours: number;
  enabled: number;
  next_run_at: string | null;
}

export interface QueueItem {
  id: number;
  downloadId?: string;
  protocol?: string;
  status?: string;
  trackedDownloadState?: string;
  size?: number;
  sizeleft?: number;
  title?: string;
  seriesId?: number;
  episodeId?: number;
  movieId?: number;
  downloadClient?: string;
}

export interface MediaFile {
  id: number;
  seriesId?: number;
  movieId?: number;
  path?: string;
  relativePath?: string;
  dateAdded?: string;
  size?: number;
  mediaInfo?: { audioLanguages?: string | null };
}

export interface HistoryItem {
  id: number;
  episodeId?: number;
  movieId?: number;
  seriesId?: number;
  eventType?: string | number;
  date?: string;
  downloadId?: string;
  sourceTitle?: string;
  data?: Record<string, unknown>;
}

export interface PreviewRow {
  connectionId: number;
  file: MediaFile;
  titleId: number;
  episodeIds: number[];
  audio: string[];
  status: "pass" | "fail" | "review";
  reason: string;
  historyId?: number;
  releaseTitle?: string;
  policyRevision: string;
}
