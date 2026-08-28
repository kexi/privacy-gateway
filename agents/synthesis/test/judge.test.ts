/**
 * What the advisory judge is asked, and what its answer is allowed to do.
 *
 * The defect these pin: the judge returned `leak: true` with an empty
 * `categories` list for essentially every answer containing `⟦TYPE_N⟧`
 * placeholders, refusing most legitimate requests even though the deterministic
 * attester passed them (docs/proof/openai-compat.md). Placeholders are the
 * evidence that masking worked, so the judge was vetoing its own masking.
 *
 * The fix is deterministic rather than a prompt tweak: placeholders are removed
 * before the model sees the text, so the question it answers is only ever "does
 * the residual prose contain personal data". These tests assert the text that
 * actually reaches the wire, because that is the part a prompt cannot promise.
 */

import { describe, expect, it } from 'vitest';
import { createLeakJudge } from '../src/agent.ts';

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
  it('strips every well-formed placeholder before the model is asked', async () => {
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
});
