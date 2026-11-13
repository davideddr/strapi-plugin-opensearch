/** Shape of `GET /opensearch/status` (mirrors `server/src/services/status.ts`). */

export type ClusterStatus =
  { ok: true; clusterName: string; version: string; distribution?: string } | { ok: false; error: string };

export interface ReindexLocaleReport {
  locale: string | null;
  alias: string;
  index: string | null;
  indexed: number;
  filtered: number;
  failed: number;
  count: number | null;
  error?: string;
}

export interface ReindexReport {
  uid: string;
  ok: boolean;
  startedAt: string;
  durationMs: number;
  locales: ReindexLocaleReport[];
  error?: string;
}

export interface LocaleStatus {
  locale: string | null;
  alias: string;
  indices: string[] | null;
  count: number | null;
  published: number | null;
  error?: string;
}

export interface ContentTypeStatus {
  uid: string;
  displayName: string;
  reindexing: boolean;
  queued: boolean;
  lastReindex: ReindexReport | null;
  locales: LocaleStatus[];
  error?: string;
}

export interface PluginStatus {
  cluster: ClusterStatus;
  running: string[];
  queued: string[];
  contentTypes: ContentTypeStatus[];
}
