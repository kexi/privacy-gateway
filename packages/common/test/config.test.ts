/**
 * What environment validation guarantees: a bad configuration stops the process
 * at boot rather than surfacing as a confusing mid-request failure.
 */

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GEMINI_MODEL, DEFAULT_VAULT_TTL_SECONDS, loadConfig } from '../src/config.ts';

/** Throws instead of exiting, so a rejection is observable in a test. */
function throwOnInvalid(message: string, issues: readonly string[]): never {
  throw new Error(`${message}: ${issues.join('; ')}`);
}

function load(env: NodeJS.ProcessEnv) {
  return loadConfig({ agent: 'gateway', env, onInvalid: throwOnInvalid });
}

describe('defaults', () => {
  it('applies the verified Gemini model id', () => {
    expect(load({}).GEMINI_MODEL).toBe(DEFAULT_GEMINI_MODEL);
  });

  it('defaults the vault to the in-memory backend', () => {
    expect(load({}).VAULT_BACKEND).toBe('memory');
  });

  it('defaults the vault TTL, which stale_after mirrors', () => {
    expect(load({}).vaultTtlSeconds).toBe(DEFAULT_VAULT_TTL_SECONDS);
  });

  it('names the Firestore collections the log guide documents', () => {
    const config = load({});
    expect(config.VAULT_COLLECTION).toBe('token_vault');
    expect(config.ANSWER_COLLECTION).toBe('gateway_answers');
  });

  it('converts the A2A timeout to milliseconds', () => {
    expect(load({ A2A_TIMEOUT_SECONDS: '30' }).requestTimeoutMs).toBe(30_000);
  });
});

describe('validation', () => {
  it('rejects an unknown vault backend', () => {
    expect(() => load({ VAULT_BACKEND: 'postgres' })).toThrow(/VAULT_BACKEND/u);
  });

  it('rejects a malformed service URL', () => {
    expect(() => load({ CORE_BASE_URL: 'not-a-url' })).toThrow(/CORE_BASE_URL/u);
  });

  it('rejects a non-integer port', () => {
    expect(() => load({ PORT: 'eighty' })).toThrow(/PORT/u);
  });

  it('rejects an unknown log level', () => {
    expect(() => load({ LOG_LEVEL: 'CHATTY' })).toThrow(/LOG_LEVEL/u);
  });

  it('reports a required variable that is unset', () => {
    expect(() =>
      loadConfig({
        agent: 'gateway',
        env: {},
        require: ['CORE_BASE_URL'],
        onInvalid: throwOnInvalid,
      }),
    ).toThrow(/CORE_BASE_URL/u);
  });

  it('emits a config.invalid event before failing', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      expect(() => load({ VAULT_BACKEND: 'postgres' })).toThrow();
      const line = write.mock.calls[0]?.[0];
      expect(typeof line).toBe('string');
      expect(JSON.parse(String(line))).toMatchObject({
        event: 'config.invalid',
        severity: 'ERROR',
        agent: 'gateway',
      });
    } finally {
      write.mockRestore();
    }
  });
});

describe('booleans', () => {
  it.each([
    ['1', true],
    ['true', true],
    ['yes', true],
    ['0', false],
    ['false', false],
  ])('reads OTEL_ENABLED=%s as %s', (value, expected) => {
    expect(load({ OTEL_ENABLED: value }).OTEL_ENABLED).toBe(expected);
  });

  it('leaves OTEL_ENABLED undefined when unset', () => {
    expect(load({}).OTEL_ENABLED).toBeUndefined();
  });
});
