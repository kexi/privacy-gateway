/**
 * What environment validation guarantees: a bad configuration stops the process
 * at boot rather than surfacing as a confusing mid-request failure.
 */

import { describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative as relative_, resolve } from 'node:path';
import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMMA_MODEL,
  DEFAULT_VAULT_TTL_SECONDS,
  loadConfig,
} from '../src/config.ts';

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

/** Files allowed to name a Gemma tag literally, and why. */
const GEMMA_TAG_ALLOWED = new Set([
  // The definition itself.
  'packages/common/src/config.ts',
]);

/** Source trees a stray fallback could hide in. Docs and tests are exempt. */
const GEMMA_TAG_ROOTS = ['packages', 'agents', 'clients', 'web/src'];

function sourceFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Build output and dependencies are not authored source.
      if (['node_modules', 'dist', 'coverage', 'test', 'e2e'].includes(entry.name)) return [];
      return sourceFiles(full);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [full] : [];
  });
}

/**
 * What this guarantees: the Gemma model tag has exactly one definition. A second
 * literal anywhere in source is how `ollama_llm.ts` and the Synthesis judge each
 * kept serving Gemma 3 after the fleet moved to Gemma 4 — the env default said
 * one thing and two independent fallbacks said another.
 */
describe('the Gemma model tag has a single source of truth', () => {
  it('appears in no source file outside config.ts', () => {
    const repoRoot = resolve(import.meta.dirname, '../../..');
    const offenders: string[] = [];

    for (const root of GEMMA_TAG_ROOTS) {
      const dir = join(repoRoot, root);
      if (!existsSync(dir)) continue;
      for (const file of sourceFiles(dir)) {
        const relative = relative_(repoRoot, file);
        if (GEMMA_TAG_ALLOWED.has(relative)) continue;
        if (/gemma[0-9]:/iu.test(readFileSync(file, 'utf8'))) offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('is the tag the adapter and the env default both resolve to', async () => {
    const { DEFAULT_GEMMA_MODEL: adapterDefault } = await import('../src/ollama_llm.ts');
    expect(adapterDefault).toBe(DEFAULT_GEMMA_MODEL);
    expect(load({}).GEMMA_MODEL).toBe(DEFAULT_GEMMA_MODEL);
  });
});
