/**
 * `_bulk` request body and response parsing. Pure functions, no Strapi or client dependency.
 */

export interface BulkItemError {
  id: string;
  status: number;
  /** `type: reason` from OpenSearch, e.g. `mapper_parsing_exception: failed to parse field [x]`. */
  reason: string;
}

export interface BulkSummary {
  indexed: number;
  failed: BulkItemError[];
}

interface BulkResponseItem {
  _id?: string;
  status?: number;
  error?: { type?: string; reason?: string } | string;
}

/** NDJSON-style body (`index` action + source per document) for `client.bulk`, `_id` = documentId. */
export const buildBulkBody = (index: string, documents: { documentId: string }[]): object[] =>
  documents.flatMap((document) => [{ index: { _index: index, _id: document.documentId } }, document]);

const describeError = (error: BulkResponseItem['error']): string => {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  return [error.type, error.reason].filter(Boolean).join(': ') || 'unknown error';
};

/**
 * Splits a `_bulk` response into succeeded/failed items. `body.errors` is only a hint: items are
 * always inspected, as each one carries its own status.
 */
export const summarizeBulkResponse = (body: { items?: Record<string, BulkResponseItem>[] }): BulkSummary => {
  const summary: BulkSummary = { indexed: 0, failed: [] };
  for (const entry of body.items ?? []) {
    const item = Object.values(entry)[0] ?? {};
    const status = item.status ?? 0;
    if (!item.error && status >= 200 && status < 300) {
      summary.indexed += 1;
    } else {
      summary.failed.push({ id: String(item._id ?? ''), status, reason: describeError(item.error) });
    }
  }
  return summary;
};
