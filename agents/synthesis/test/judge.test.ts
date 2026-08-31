/**
 * What the advisory judge is asked, and what its answer is allowed to do.
 *
 * The defect these pin: the judge returned `leak: true` with an empty
 * `categories` list for essentially every answer containing `⟦TYPE_N⟧`
 * placeholders, refusing most legitimate requests even though the deterministic
 * attester passed them (docs/proof/openai-compat.md). Placeholders are the
 * evidence that masking worked, so the judge was vetoing its own masking.
 *
 * The fix is deterministic rather than a prompt tweak: placeholders are replaced
 * with neutral markers before the model sees the text, so the question it
 * answers is only ever "does this prose contain a real value". These tests
 * assert the text that actually reaches the wire, because that is the part a
 * prompt cannot promise.
 *
 * The replacement supersedes an earlier fix that deleted placeholders outright.
 * Deleting left a sentence full of gaps, and a model asked to audit one infers
 * what the gaps held — so the false positives it was meant to stop persisted at
 * a lower rate. A marker says the same thing without inviting the inference.
 */

import { describe, expect, it } from 'vitest';
import { buildJudgeMessage, createLeakJudge, JUDGE_PROMPT_CONTEXT_LIMIT } from '../src/agent.ts';

/** The masked shape Core really returns: prose with placeholders in it. */
const MASKED_ANSWER =
  'I have confirmed the refund for ⟦PERSON_1⟧ and sent it to ⟦EMAIL_1⟧. ' +
  'We will also call ⟦PHONE_1⟧ if anything changes.';

/** Captures the request body a judge call would put on the wire. */
function recordingFetch(verdict: unknown): {
  fetchImpl: typeof fetch;
  bodies: () => Array<{ messages: Array<{ role: string; content: string }> }>;
} {
  const seen: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const fetchImpl = ((_url: string, init?: { body?: string }) => {
    seen.push(JSON.parse(init?.body ?? '{}'));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify(verdict) } }] }),
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, bodies: () => seen };
}

/** The text the model was actually shown. */
function userContent(body: { messages: Array<{ role: string; content: string }> }): string {
  return body.messages.find((message) => message.role === 'user')?.content ?? '';
}

describe('the judge never sees a placeholder', () => {
  it('replaces every well-formed placeholder before the model is asked', async () => {
    const { fetchImpl, bodies } = recordingFetch({ leak: false });
    const judge = createLeakJudge({ baseUrl: 'http://gemma.test/v1', auth: 'none', fetchImpl });

    await judge(MASKED_ANSWER);

    const shown = userContent(bodies()[0]!);
    expect(shown).not.toMatch(/⟦[A-Z_]+_\d+⟧/u);
    // The surrounding prose must survive: stripping is what makes the residual
    // judgeable, not a way of blanking the input.
    expect(shown).toContain('I have confirmed the refund for');
    expect(shown).toContain('if anything changes');
  });

  it('passes placeholder-laden clean text, where it used to veto', async () => {
    // The regression itself: this exact shape produced `leak: true` in
    // production. With the placeholders gone there is nothing left to flag.
    const { fetchImpl } = recordingFetch({ leak: false });
    const judge = createLeakJudge({ baseUrl: 'http://gemma.test/v1', auth: 'none', fetchImpl });

    expect(await judge(MASKED_ANSWER)).toMatchObject({ leak: false });
  });

  it('keeps a malformed near-placeholder in view rather than swallowing it', async () => {
    // `⟦EMAIL⟧` has no index, so it is not something this system minted. Only
    // the well-formed form is provably a mask, so anything else must still be
    // judged.
    const { fetchImpl, bodies } = recordingFetch({ leak: false });
    const judge = createLeakJudge({ baseUrl: 'http://gemma.test/v1', auth: 'none', fetchImpl });

    await judge('contact ⟦EMAIL⟧ and ⟦EMAIL_2⟧');

    const shown = userContent(bodies()[0]!);
    expect(shown).toContain('⟦EMAIL⟧');
    expect(shown).not.toContain('⟦EMAIL_2⟧');
  });
});

describe('stripping does not weaken the judge', () => {
  it('still reports a leak when real PII survives in the residual text', async () => {
    // The property that makes the fix safe: removing placeholders removes only
    // the masked spans, so an unmasked value is still in front of the model and
    // its verdict still blocks the release.
    const { fetchImpl, bodies } = recordingFetch({ leak: true, categories: ['EMAIL'] });
    const judge = createLeakJudge({ baseUrl: 'http://gemma.test/v1', auth: 'none', fetchImpl });

    const verdict = await judge('refund sent to ⟦PERSON_1⟧ at real.person@example.com');

    expect(userContent(bodies()[0]!)).toContain('real.person@example.com');
    expect(verdict.leak).toBe(true);
    expect(verdict.categories).toEqual(['EMAIL']);
  });

  it('has no opinion when the judge is unavailable, so the pipeline blocks', async () => {
    // `leak: null` is "no usable verdict", which the pipeline treats as
    // `judge_unavailable` and refuses. A transport failure must never read as
    // an all-clear.
    const failing = (() => Promise.resolve({ ok: false, status: 503 })) as unknown as typeof fetch;
    const judge = createLeakJudge({
      baseUrl: 'http://gemma.test/v1',
      auth: 'none',
      fetchImpl: failing,
    });

    expect(await judge(MASKED_ANSWER)).toEqual({ leak: null });
  });

  it('has no opinion when the model answers with something unparseable', async () => {
    const { fetchImpl } = recordingFetch('not json at all');
    const judge = createLeakJudge({ baseUrl: 'http://gemma.test/v1', auth: 'none', fetchImpl });

    expect(await judge(MASKED_ANSWER)).toEqual({ leak: null });
  });

  it('constrains the verdict to a schema and caps its budget on the wire', async () => {
    // Structured outputs plus max_tokens: a drifting judge can neither answer
    // in prose nor pin a GPU slot with runaway generation.
    const { fetchImpl, bodies } = recordingFetch({ leak: false });
    const judge = createLeakJudge({ baseUrl: 'http://gemma.test/v1', auth: 'none', fetchImpl });
    await judge(MASKED_ANSWER);

    const body = bodies()[0] as unknown as {
      response_format: { type: string; json_schema: { schema: { required: string[] } } };
      max_tokens: number;
    };
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.schema.required).toEqual(['leak']);
    expect(body.max_tokens).toBe(1024);
  });
});

describe('the judge is given context, not a text in a vacuum', () => {
  const CONTEXT = {
    maskedPrompt: 'Reply to ⟦PERSON_1⟧ at ⟦EMAIL_1⟧ about the failed charge.',
    maskedCounts: { EMAIL: 1, PERSON: 1 },
  };

  it('shows the request, the masked counts, and the answer', () => {
    const message = buildJudgeMessage(MASKED_ANSWER, CONTEXT);

    expect(message).toContain('## The request this answers (already masked)');
    expect(message).toContain('## What was masked out of this exchange');
    expect(message).toContain('## Answer to judge');
    // Counts are safe metadata: the categories are already public in the
    // placeholders, the OKF document and the API response.
    expect(message).toContain('EMAIL: 1, PERSON: 1');
  });

  it('neutralizes the context prompt too, so no placeholder reaches the judge', () => {
    // The guarantee has to cover the context exactly as it covers the answer,
    // or the context becomes the hole in it.
    const message = buildJudgeMessage(MASKED_ANSWER, CONTEXT);

    expect(message).not.toContain('⟦');
    expect(message).toContain('[masked person]');
    expect(message).toContain('[masked email]');
  });

  it('truncates a long request and says that it did', () => {
    const message = buildJudgeMessage(MASKED_ANSWER, {
      maskedPrompt: 'x'.repeat(JUDGE_PROMPT_CONTEXT_LIMIT + 500),
      maskedCounts: {},
    });

    expect(message).toContain('[… request truncated for length …]');
    // The marker stops the model reading the cut as the request ending there.
    expect(message.length).toBeLessThan(JUDGE_PROMPT_CONTEXT_LIMIT + 500);
  });

  it('says so plainly when nothing was masked', () => {
    const message = buildJudgeMessage('An ordinary answer.', {
      maskedPrompt: 'An ordinary request.',
      maskedCounts: {},
    });

    expect(message).toContain('nothing was masked in this exchange');
  });

  it('still works without context, for a caller that supplies none', () => {
    const message = buildJudgeMessage(MASKED_ANSWER);

    expect(message).toContain('## Answer to judge');
    expect(message).not.toContain('## The request this answers');
    expect(message).not.toContain('⟦');
  });

  it('is deterministic, so a verdict cannot depend on the rendering', () => {
    expect(buildJudgeMessage(MASKED_ANSWER, CONTEXT)).toBe(
      buildJudgeMessage(MASKED_ANSWER, CONTEXT),
    );
  });

  it('puts the context on the wire when the pipeline supplies it', async () => {
    const { fetchImpl, bodies } = recordingFetch({ leak: false });
    const judge = createLeakJudge({ baseUrl: 'http://gemma.test/v1', auth: 'none', fetchImpl });

    await judge(MASKED_ANSWER, undefined, CONTEXT);

    const shown = userContent(bodies()[0]!);
    expect(shown).toContain('about the failed charge');
    expect(shown).toContain('EMAIL: 1');
  });

  it('still flags a real value that survives alongside the context', async () => {
    // Context must not blunt the judge: an actual value is still in front of it
    // and its verdict still blocks the release.
    const { fetchImpl, bodies } = recordingFetch({ leak: true, categories: ['EMAIL'] });
    const judge = createLeakJudge({ baseUrl: 'http://gemma.test/v1', auth: 'none', fetchImpl });

    const verdict = await judge(
      'Refund sent to ⟦PERSON_1⟧ at real.person@example.com',
      undefined,
      CONTEXT,
    );

    expect(userContent(bodies()[0]!)).toContain('real.person@example.com');
    expect(verdict.leak).toBe(true);
  });
});
