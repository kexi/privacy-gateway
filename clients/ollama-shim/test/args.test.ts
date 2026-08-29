/**
 * What these tests guarantee: the two run modes resolve to the ports the README
 * documents, and the bind address defaults to loopback — a shim reachable off
 * the host would be an unauthenticated proxy to the fleet.
 */

import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/index.ts';
import { DEFAULT_PORT, TAKEOVER_PORT } from '../src/server.ts';

describe('parseArgs', () => {
  it('defaults to the side-by-side port and loopback', () => {
    expect(parseArgs([])).toEqual({ port: DEFAULT_PORT, host: '127.0.0.1', help: false });
  });

  it('binds the real Ollama port under --takeover', () => {
    expect(parseArgs(['--takeover']).port).toBe(TAKEOVER_PORT);
  });

  it('accepts --port in both spellings', () => {
    expect(parseArgs(['--port', '9000']).port).toBe(9000);
    expect(parseArgs(['--port=9001']).port).toBe(9001);
  });

  it('lets an explicit --port win over --takeover, because the operator named it', () => {
    expect(parseArgs(['--takeover', '--port', '9002']).port).toBe(9002);
  });

  it('recognises --help', () => {
    expect(parseArgs(['--help']).help).toBe(true);
    expect(parseArgs(['-h']).help).toBe(true);
  });
});
