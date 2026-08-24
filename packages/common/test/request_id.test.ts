/**
 * What request ids guarantee: they are well-formed UUIDv7, sort by time, and an
 * untrusted inbound value is never echoed into logs unchecked.
 */

import { describe, expect, it } from 'vitest';
import { resolveRequestId, uuidv7 } from '../src/request_id.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

describe('uuidv7', () => {
  it('produces a well-formed UUID', () => {
    expect(uuidv7()).toMatch(UUID_RE);
  });

  it('sets the version to 7 and the RFC 4122 variant', () => {
    const id = uuidv7();
    expect(id[14]).toBe('7');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('sorts chronologically, so a log ordering by id is ordered by time', () => {
    const earlier = uuidv7(1_700_000_000_000);
    const later = uuidv7(1_800_000_000_000);
    expect(earlier < later).toBe(true);
  });

  it('encodes the supplied timestamp in the leading 48 bits', () => {
    const now = 1_755_000_000_000;
    const hex = uuidv7(now).replace(/-/gu, '').slice(0, 12);
    expect(Number.parseInt(hex, 16)).toBe(now);
  });

  it('does not repeat itself', () => {
    const ids = new Set(Array.from({ length: 500 }, () => uuidv7()));
    expect(ids.size).toBe(500);
  });
});

describe('resolveRequestId', () => {
  it('adopts a well-formed inbound id so the hop keeps one identity', () => {
    const inbound = '0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b';
    expect(resolveRequestId(inbound)).toBe(inbound);
  });

  it('lowercases an uppercase inbound id', () => {
    expect(resolveRequestId('0192A3B4-C5D6-7E8F-8A9B-0C1D2E3F4A5B')).toBe(
      '0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b',
    );
  });

  it('mints a fresh id when none is supplied', () => {
    expect(resolveRequestId(undefined)).toMatch(UUID_RE);
  });

  it('rejects a malformed inbound id rather than echoing it', () => {
    // The id reaches logs and the OKF document, so an arbitrary caller string
    // would be a log-injection vector.
    const resolved = resolveRequestId('"; DROP TABLE logs; --');
    expect(resolved).toMatch(UUID_RE);
  });

  it('takes the first value when a header repeats', () => {
    const first = '0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b';
    expect(resolveRequestId([first, 'other'])).toBe(first);
  });
});
