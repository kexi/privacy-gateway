/**
 * What Core's dependency graph guarantees: Core cannot reach the token vault.
 *
 * This is the structural half of the trust boundary. The other half — the IAM
 * binding that denies Core's service account any Firestore role — lives in
 * `infra/terraform/iam.tf`; this test pins the code side, so a future import cannot
 * quietly undo it.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));

/**
 * Subpaths of the shared package Core may import.
 *
 * None of them reach the vault: `config` and `schema` are pure declarations,
 * `logging` and `telemetry` hold no persistence. The bare package entry point is
 * absent on purpose — it re-exports the vault and the tokenizer.
 */
const ALLOWED_COMMON_SUBPATHS = new Set([
  '@privacy-gateway/common/config',
  '@privacy-gateway/common/logging',
  '@privacy-gateway/common/schema',
  '@privacy-gateway/common/telemetry',
]);

/** Packages that would give Core a path to the vault or the token mapping. */
const FORBIDDEN_SPECIFIERS = [
  '@google-cloud/firestore',
  '@privacy-gateway/gateway',
  '@privacy-gateway/synthesis',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** Every module specifier imported by a file. */
function importsOf(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const specifiers: string[] = [];
  for (const match of source.matchAll(/from\s+'([^']+)'|import\('([^']+)'\)/gu)) {
    const specifier = match[1] ?? match[2];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

describe('the trust boundary', () => {
  const files = sourceFiles(SRC_DIR);

  it('has source files to inspect', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('never imports the shared package entry point', () => {
    // The entry point re-exports the vault and the tokenizer; importing it would
    // turn "Core cannot read the vault" from a structural fact into a convention.
    for (const file of files) {
      expect(importsOf(file), file).not.toContain('@privacy-gateway/common');
    }
  });

  it('imports only the vault-free subpaths of the shared package', () => {
    for (const file of files) {
      for (const specifier of importsOf(file)) {
        if (!specifier.startsWith('@privacy-gateway/common')) continue;
        expect(ALLOWED_COMMON_SUBPATHS, `${file} imports ${specifier}`).toContain(specifier);
      }
    }
  });

  it('never imports a package that could reach the token mapping', () => {
    for (const file of files) {
      const specifiers = importsOf(file);
      for (const forbidden of FORBIDDEN_SPECIFIERS) {
        expect(specifiers, `${file} imports ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it('declares no Firestore dependency', () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('@google-cloud/firestore');
  });
});
