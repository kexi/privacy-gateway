#!/usr/bin/env node
/**
 * Entry point: parse flags, start the server.
 *
 * Two modes, and the difference is only which port is bound:
 *
 * - **side-by-side** (default, 11435): the real Ollama keeps 11434 and both run.
 * - **`--takeover`** (11434): for a client that hardcodes Ollama's port. The
 *   real Ollama must be stopped first; the shim refuses rather than fighting for
 *   the port, because a half-bound listener is worse than a clear failure.
 */

import { pathToFileURL } from 'node:url';
import { DEFAULT_PORT, startServer, TAKEOVER_PORT } from './server.ts';

interface Flags {
  readonly port: number;
  readonly host: string;
  readonly help: boolean;
}

/** Parse argv. Exported for the tests: flag handling is a contract too. */
export function parseArgs(argv: readonly string[]): Flags {
  let port: number | undefined;
  let takeover = false;
  let host = '127.0.0.1';
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--takeover') takeover = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--port') {
      const value = argv[i + 1];
      if (value !== undefined) {
        port = Number.parseInt(value, 10);
        i += 1;
      }
    } else if (arg?.startsWith('--port=')) {
      port = Number.parseInt(arg.slice('--port='.length), 10);
    } else if (arg === '--host') {
      const value = argv[i + 1];
      if (value !== undefined) {
        host = value;
        i += 1;
      }
    }
  }

  // An explicit --port wins over --takeover: the operator named a port.
  const resolved = port ?? (takeover ? TAKEOVER_PORT : DEFAULT_PORT);
  return { port: resolved, host, help };
}

const USAGE = `pgw-ollama-shim — expose the Privacy-Preserving Gateway as a selectable model

  --port <n>    bind this port (default ${DEFAULT_PORT})
  --takeover    bind ${TAKEOVER_PORT}, the port a real Ollama owns; stop Ollama first
  --host <addr> bind address (default 127.0.0.1; changing this publishes an
                unauthenticated proxy to the fleet)
  --help        show this message

Environment:
  PGW_GATEWAY_URL  the Gateway base URL (defaults to the deployed Gateway)
`;

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));

  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }

  try {
    await startServer({ port: flags.port, host: flags.host });
  } catch (error) {
    const isPortTaken = error instanceof Error && 'code' in error && error.code === 'EADDRINUSE';
    if (isPortTaken) {
      process.stderr.write(
        `port ${flags.port} is already in use.` +
          (flags.port === TAKEOVER_PORT
            ? ' Stop the real Ollama before using --takeover.\n'
            : ' Choose another with --port.\n'),
      );
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

// Only run when executed directly, so importing the module in a test does not
// bind a port.
// Compared as resolved file URLs rather than by basename, which would also
// match an unrelated file that happened to share a name.
const invokedPath = process.argv[1];
const isEntryPoint =
  invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href;
if (isEntryPoint) {
  await main();
}

export { main };
