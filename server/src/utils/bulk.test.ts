import { describe, expect, it } from 'vitest';
import { buildBulkBody, summarizeBulkResponse } from './bulk';

describe('bulk helpers', () => {
  it('builds index actions with _id = documentId', () => {
    expect(buildBulkBody('idx_v1', [{ documentId: 'a' }, { documentId: 'b' }])).toEqual([
      { index: { _index: 'idx_v1', _id: 'a' } },
      { documentId: 'a' },
      { index: { _index: 'idx_v1', _id: 'b' } },
      { documentId: 'b' },
    ]);
  });

  it('counts succeeded items and describes the failed ones', () => {
    const summary = summarizeBulkResponse({
      items: [
        { index: { _id: 'a', status: 201 } },
        { index: { _id: 'b', status: 200 } },
        {
          index: {
            _id: 'c',
            status: 400,
            error: { type: 'mapper_parsing_exception', reason: 'failed to parse field [publishedAt]' },
          },
        },
        { index: { _id: 'd', status: 429, error: 'rejected' } },
      ],
    });
    expect(summary.indexed).toBe(2);
    expect(summary.failed).toEqual([
      { id: 'c', status: 400, reason: 'mapper_parsing_exception: failed to parse field [publishedAt]' },
      { id: 'd', status: 429, reason: 'rejected' },
    ]);
  });

  it('handles an empty response', () => {
    expect(summarizeBulkResponse({})).toEqual({ indexed: 0, failed: [] });
  });
});
