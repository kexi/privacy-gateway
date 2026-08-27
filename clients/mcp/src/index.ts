#!/usr/bin/env node
/**
 * The `pgw-mcp` entry point: an MCP stdio server.
 *
 * stdio is the transport, so **stdout is the protocol channel**. Anything
 * written there that is not a JSON-RPC frame corrupts the session, which is why
 * the one startup line below goes to stderr and why nothing in this package
 * calls `console.log`.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { pathToFileURL } from 'node:url';
import { DEFAULT_GATEWAY_URL } from './client.ts';
import { buildServer } from './server.ts';

export { buildServer } from './server.ts';

async function main(): Promise<void> {
  const gatewayUrl = process.env['PGW_GATEWAY_URL'] ?? DEFAULT_GATEWAY_URL;
  const server = buildServer({ gatewayUrl });

  await server.connect(new StdioServerTransport());

  // The base URL is deployment topology, not request content, so naming it is
  // safe — and it is the first thing to check when the tools cannot connect.
  process.stderr.write(`privacy-gateway MCP server ready (gateway: ${gatewayUrl})\n`);
}

// Only run when this file is the process entry point, not when imported.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  void main().catch((error: unknown) => {
    // Never the message: an exception message can embed the value that caused it.
    process.stderr.write(
      `privacy-gateway MCP server failed to start: ${error instanceof Error ? error.name : 'unknown'}\n`,
    );
    process.exitCode = 1;
  });
}
