/**
 * What the Token Vault guarantees: per-request storage, merging on append, a
 * monotonic generation counter, and blocking access once expired.
 */

import { describe, expect, it } from 'vitest';
import { buildVault, InMemoryTokenVault, isExpired } from '../src/vault.ts';

describe('in-memory vault', () => {
  it('reads back a stored mapping', async () => {
    const vault = new InMemoryTokenVault();
    await vault.put('s1', { '⟦EMAIL_1⟧': 'a@b.co' }, 60);

    const entry = await vault.get('s1');
    expect(entry?.mapping).toEqual({ '⟦EMAIL_1⟧': 'a@b.co' });
  });

  it('returns nothing for an unknown session', async () => {
    expect(await new InMemoryTokenVault().get('nope')).toBeNull();
  });

  it('isolates sessions from each other', async () => {
    const vault = new InMemoryTokenVault();
    await vault.put('s1', { '⟦EMAIL_1⟧': 'a@b.co' }, 60);
    await vault.put('s2', { '⟦EMAIL_1⟧': 'c@d.co' }, 60);

    expect((await vault.get('s1'))?.mapping['⟦EMAIL_1⟧']).toBe('a@b.co');
    expect((await vault.get('s2'))?.mapping['⟦EMAIL_1⟧']).toBe('c@d.co');
  });

  it('merges instead of replacing on a second write', async () => {
    const vault = new InMemoryTokenVault();
    await vault.put('s1', { '⟦EMAIL_1⟧': 'a@b.co' }, 60);
    await vault.put('s1', { '⟦PHONE_1⟧': '090-1234-5678' }, 60);

    const entry = await vault.get('s1');
    expect(Object.keys(entry?.mapping ?? {}).sort()).toEqual(['⟦EMAIL_1⟧', '⟦PHONE_1⟧']);
  });

  it('does not extend the expiry when appending', async () => {
    // stale_after is contracted to match the vault expiry, so an append must not move it.
    const vault = new InMemoryTokenVault();
    const first = await vault.put('s1', { '⟦EMAIL_1⟧': 'a@b.co' }, 60);
    const second = await vault.put('s1', { '⟦PHONE_1⟧': '090-1234-5678' }, 3600);

    expect(second.expiresAt.getTime()).toBe(first.expiresAt.getTime());
  });

  it('stops serving an expired entry', async () => {
    const vault = new InMemoryTokenVault();
    await vault.put('s1', { '⟦EMAIL_1⟧': 'a@b.co' }, 0);
    expect(await vault.get('s1')).toBeNull();
  });

  it('forgets a deleted session', async () => {
    const vault = new InMemoryTokenVault();
    await vault.put('s1', { '⟦EMAIL_1⟧': 'a@b.co' }, 60);
    await vault.delete('s1');
    expect(await vault.get('s1')).toBeNull();
  });

  it('reports its own expiry on the entry', async () => {
    const entry = await new InMemoryTokenVault().put('s1', {}, 3600);
    expect(entry.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(entry.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 3601 * 1000);
    expect(isExpired(entry)).toBe(false);
  });

  it('starts at generation 1 and advances on every allocating write', async () => {
    // Synthesis refuses to rehydrate against any generation but the one the
    // gateway wrote, so the counter must move whenever the mapping does.
    const vault = new InMemoryTokenVault();
    expect((await vault.put('r1', { '⟦EMAIL_1⟧': 'a@b.co' }, 60)).generation).toBe(1);
    expect((await vault.put('r1', { '⟦PHONE_1⟧': '090-1234-5678' }, 60)).generation).toBe(2);
    expect((await vault.get('r1'))?.generation).toBe(2);
  });

  it('restarts the generation after expiry rather than continuing it', async () => {
    // The old entry is gone, so a delayed answer holding generation 1 cannot
    // match: it sees a fresh generation 1 over a different mapping and the
    // caller's own generation check is what stops it.
    const vault = new InMemoryTokenVault();
    await vault.put('r1', { '⟦EMAIL_1⟧': 'a@b.co' }, 0);
    expect((await vault.put('r1', { '⟦EMAIL_1⟧': 'c@d.co' }, 60)).generation).toBe(1);
  });
});

describe('backend selection', () => {
  it('selects the memory backend by name', () => {
    expect(buildVault('memory')).toBeInstanceOf(InMemoryTokenVault);
  });

  it('rejects an unknown backend loudly', () => {
    expect(() => buildVault('postgres')).toThrow(/unknown VAULT_BACKEND/u);
  });
});
