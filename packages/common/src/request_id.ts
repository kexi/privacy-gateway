/**
 * Request correlation ids.
 *
 * UUIDv7 rather than v4: the leading 48 bits are a millisecond timestamp, so ids
 * sort chronologically. That makes a Logs Explorer result set ordered by
 * `request_id` also ordered by time, and it lets an id be read as an approximate
 * clock when correlating against a deploy.
 */

import { randomBytes } from 'node:crypto';

/**
 * Generate a UUIDv7.
 *
 * Layout: 48-bit big-endian timestamp, 4-bit version (7), 12 random bits, 2-bit
 * variant, 62 random bits.
 */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);

  // 48-bit millisecond timestamp, most significant byte first.
  const timestamp = BigInt(now);
  for (let index = 0; index < 6; index += 1) {
    bytes[index] = Number((timestamp >> BigInt(8 * (5 - index))) & 0xffn);
  }

  // Version 7 in the high nibble of byte 6.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  // RFC 4122 variant in the two high bits of byte 8.
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/** Loose UUID shape check; rejects obviously unusable inbound values. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Take the caller's request id when it is well formed, otherwise mint one.
 *
 * Why validate? The id is echoed into logs and into the OKF document, so an
 * unbounded caller-supplied string would be both a log-injection vector and a
 * way to make audit records unsearchable.
 */
export function resolveRequestId(inbound: string | string[] | undefined): string {
  const candidate = Array.isArray(inbound) ? inbound[0] : inbound;
  if (candidate !== undefined && UUID_RE.test(candidate.trim())) {
    return candidate.trim().toLowerCase();
  }
  return uuidv7();
}
