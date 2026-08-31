/**
 * Local reproduction harness for the Gemma span-extraction path.
 *
 * Runs `extractUnstructured` against a real Ollama on localhost with a
 * Codex-shaped payload — markdown headings, fenced code, JSON tool schemas,
 * braces everywhere — which is the content that makes the model break its
 * JSON-only contract in production. Production cannot show a failing chunk's raw
 * model output by design (the answer would carry the input's PII into a log), so
 * this is where that output is inspected.
 *
 * Local only. It needs a running `ollama serve` holding the production model and
 * is never part of CI: it makes real model calls whose timing is the whole point.
 *
 *   just extraction-lab
 *   just extraction-lab 40000            # a smaller payload, default model
 *   just extraction-lab 40000 <tag>      # an explicit Ollama tag
 *
 * Prints, per chunk, whether the answer parsed and — when it did not — the raw
 * text the model returned, so a failure can be classified rather than guessed at.
 *
 * ## This is a stress fixture, not a wire capture
 *
 * The payload is **synthetic and deliberately worst-case**, and it does not go
 * through the Responses projection. It embeds JSON tool schemas directly in the
 * text, whereas a real `/v1/responses` request carries its `tools` in a
 * top-level field that `flattenResponsesInput` accepts and **drops** — only
 * `instructions` plus the message turns are forwarded into masking. So the bytes
 * this harness extracts are not the bytes a Codex turn extracts, and its chunk
 * count must never be quoted as one.
 *
 * That is on purpose: the job here is to provoke the JSON-contract failure with
 * the densest brace-heavy content available, which is a different job from
 * measuring what a real request costs. The real figure is measured on the live
 * path instead — the Gateway logs `forwarded_text_bytes` and `raw_body_bytes` on
 * `openai.compat.responses.start`, and the gap between them is exactly what the
 * projection drops. Capacity and latency claims cite those, never this file.
 */

import {
  buildExtractionPrompt,
  buildSpanAgent,
  chunkText,
  extractionChunkBytes,
  extractUnstructured,
  looksTruncated,
  parseSpans,
} from '../src/agent.ts';
import { DEFAULT_GEMMA_MODEL } from '@privacy-gateway/common';
import { InMemoryRunner } from '@google/adk';

/** The endpoint the harness drives. Local by default; never a deployed one. */
const BASE_URL = process.env['GEMMA_BASE_URL'] ?? 'http://localhost:11434/v1';
// The tag is never written literally here: `config.ts` is its single source of
// truth, and a second literal is how two components once kept serving the
// previous Gemma generation after the fleet had moved on.
// An empty argument (the recipe's default) is treated as absent, not as a model
// named "": `just extraction-lab 40000` must still resolve a tag.
const MODEL =
  [process.argv[3], process.env['GEMMA_MODEL']].find(
    (candidate) => candidate !== undefined && candidate.trim() !== '',
  ) ?? DEFAULT_GEMMA_MODEL;
const TARGET_BYTES = Number(process.argv[2] ?? '60000');

/**
 * Synthetic content in the shape of a coding-agent CLI's instruction block.
 *
 * Deliberately assembled rather than captured from a real Codex session: a
 * capture would carry the operator's own workspace paths and identifiers into a
 * file in this repository. The properties that matter for the failure are
 * structural — fenced code, JSON schemas, markdown, unbalanced braces in prose —
 * and those are reproduced exactly. The few personal names are invented, so a
 * correct extraction has something to find and can be told from an empty one.
 */
function codexLikePayload(targetBytes: number): string {
  const sections: string[] = [];
  let index = 0;

  while (sections.join('\n\n').length < targetBytes) {
    index += 1;
    sections.push(
      [
        `## Tool ${index}: workspace_search`,
        '',
        'Searches the workspace. Call it before editing a file you have not read.',
        'The `pattern` argument is a regular expression; escape `{` and `}` in it.',
        '',
        '```json',
        JSON.stringify(
          {
            name: `workspace_search_${index}`,
            description: 'Search the workspace for a pattern.',
            parameters: {
              type: 'object',
              properties: {
                pattern: { type: 'string', description: 'A regular expression.' },
                path: { type: 'string', description: 'Directory to search under.' },
                limit: { type: 'integer', minimum: 1, maximum: 100 },
              },
              required: ['pattern'],
            },
          },
          null,
          2,
        ),
        '```',
        '',
        '### Example',
        '',
        '```typescript',
        `export function handler${index}(request: Request): Response {`,
        '  const { pattern, path } = parse(request);',
        '  if (pattern === undefined) { throw new Error("pattern is required"); }',
        `  return search({ pattern, path, limit: ${index * 7} });`,
        '}',
        '```',
        '',
        '### Notes',
        '',
        `- Reviewed by Hanako Suzuki of Kitano Systems on 2026-0${(index % 9) + 1}-14.`,
        '- Do not call this tool more than once per turn.',
        '- Output must be valid JSON; a trailing `}` in prose does not close an object.',
      ].join('\n'),
    );
  }
  return sections.join('\n\n');
}

/** One raw model call, bypassing the parse so the answer can be inspected. */
async function rawAnswer(agent: ReturnType<typeof buildSpanAgent>, text: string): Promise<string> {
  const runner = new InMemoryRunner({ agent, appName: 'extraction_lab' });
  const parts: string[] = [];
  for await (const event of runner.runEphemeral({
    userId: 'lab',
    newMessage: { role: 'user', parts: [{ text: buildExtractionPrompt(text) }] },
  })) {
    if (event.content?.parts === undefined) continue;
    for (const part of event.content.parts) {
      if (typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('').trim();
}

async function main(): Promise<void> {
  const text = codexLikePayload(TARGET_BYTES);
  const chunkBytes = extractionChunkBytes();
  const chunks = chunkText(text, chunkBytes);

  process.stdout.write(
    `model=${MODEL} base=${BASE_URL}\n` +
      `payload=${text.length} bytes chunk_bytes=${chunkBytes} chunks=${chunks.length}\n\n`,
  );

  const agent = buildSpanAgent({ model: MODEL, baseUrl: BASE_URL, apiKey: 'ollama' });
  const classes = new Map<string, number>();
  let failures = 0;

  // Sequential on purpose: the point is to read each answer, and interleaved
  // output from a fan-out would make a failing chunk hard to attribute.
  for (const [position, chunk] of chunks.entries()) {
    const startedAt = Date.now();
    const raw = await rawAnswer(agent, chunk);
    const elapsed = Date.now() - startedAt;
    const result = parseSpans(raw);

    if (result.kind === 'invalid') {
      failures += 1;
      const label = looksTruncated(raw) ? `truncated: ${result.reason}` : result.reason;
      classes.set(label, (classes.get(label) ?? 0) + 1);
      process.stdout.write(
        `chunk ${position + 1}/${chunks.length} (${chunk.length}B, ${elapsed}ms) INVALID ${label}\n` +
          `  raw: ${JSON.stringify(raw.slice(0, 600))}\n\n`,
      );
      continue;
    }

    const found = result.kind === 'valid-spans' ? result.spans.length : 0;
    classes.set('ok', (classes.get('ok') ?? 0) + 1);
    process.stdout.write(
      `chunk ${position + 1}/${chunks.length} (${chunk.length}B, ${elapsed}ms) ok spans=${found}\n`,
    );
  }

  process.stdout.write(`\nper-chunk outcome: ${JSON.stringify(Object.fromEntries(classes))}\n`);

  // The full path, including chunking, bisection and the cache — what a request
  // actually pays. Run twice: the second timing is what a repeat turn costs.
  for (const label of ['cold', 'cached']) {
    const startedAt = Date.now();
    try {
      const detections = await extractUnstructured(text, {
        model: MODEL,
        baseUrl: BASE_URL,
        apiKey: 'ollama',
      });
      process.stdout.write(
        `${label}: ${Date.now() - startedAt}ms, ${detections.length} detections\n`,
      );
    } catch (error) {
      process.stdout.write(
        `${label}: ${Date.now() - startedAt}ms, FAILED ${error instanceof Error ? error.name : 'unknown'}\n`,
      );
    }
  }

  // A non-zero exit makes a regression visible to a human running this by hand;
  // nothing in CI depends on it.
  if (failures > 0) process.exitCode = 1;
}

await main();
