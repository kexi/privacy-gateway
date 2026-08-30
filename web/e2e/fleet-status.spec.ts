/**
 * What the GPU badge and the pipeline checklist guarantee in a real browser.
 *
 * Two claims are worth asserting here rather than in a unit test, because both
 * are about what a person actually sees. The badge must report the fleet's state
 * before anything is submitted — that is the entire point of deriving it from a
 * recorded timestamp instead of probing Gemma. And the checklist must fill in as
 * the request progresses, then stop visibly at the gate that refused, so a
 * two-minute wait reads as work rather than as a hang.
 *
 * The badge specs drive `/v1/status` from a route mock: the real fleet's warmth
 * depends on whether an earlier spec happened to run first, and a status badge
 * that is only testable in one execution order is not testable.
 */

import { expect, test, type Page } from '@playwright/test';

const CUSTOMER_EMAIL =
  'Customer Taro Yamada (taro@example.co.jp, 090-1234-5678) reports that the charge on ' +
  'card 4242 4242 4242 4242 failed. Our API key sk-abcdefghijklmnopqrstuvwxyz012345 was ' +
  'used from 192.168.10.5. Draft a reply and a Python snippet to update the record.';

/** The marker `fleet-server.ts` reads to make Core leak, so Synthesis refuses. */
const LEAK_MARKER = 'SCENARIO-LEAK';

/** Serve a fixed status document so the badge's state is the spec's to choose. */
async function mockStatus(
  page: Page,
  body: {
    gemma: string;
    last_active_at?: string;
    warmup_requested_at?: string;
    cold_start_estimate_seconds?: number;
  },
): Promise<void> {
  await page.route('**/v1/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cold_start_estimate_seconds: 120, ...body }),
    }),
  );
}

/**
 * Serve a status document that changes after the warmup is posted.
 *
 * The badge's whole job is to move, so a fixed mock cannot show the behaviour
 * under test: the route reads a mutable cell that the `/v1/warmup` mock flips.
 */
async function mockStatusSequence(page: Page, state: { gemma: string }): Promise<void> {
  await page.route('**/v1/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cold_start_estimate_seconds: 120, gemma: state.gemma }),
    }),
  );
}

test.describe('the GPU badge', () => {
  test('renders warm from the status endpoint', async ({ page }) => {
    await mockStatus(page, { gemma: 'warm', last_active_at: new Date().toISOString() });
    await page.goto('/');

    const badge = page.locator('#gpu-badge');
    await expect(badge).toHaveAttribute('data-state', 'warm');
    await expect(badge).toHaveText(/warm/i);
    // Nothing to warn about: a warm fleet answers immediately.
    await expect(page.locator('#gpu-note')).toBeHidden();
  });

  test('warns about the cold-start wait when the fleet is cold', async ({ page }) => {
    await mockStatus(page, { gemma: 'cold' });
    await page.goto('/');

    await expect(page.locator('#gpu-badge')).toHaveAttribute('data-state', 'cold');
    await expect(page.locator('#gpu-note')).toBeVisible();
    await expect(page.locator('#gpu-note')).toContainText(/2 minutes/i);
  });

  test('reports unknown rather than guessing when the store is unreadable', async ({ page }) => {
    await mockStatus(page, { gemma: 'unknown' });
    await page.goto('/');

    await expect(page.locator('#gpu-badge')).toHaveAttribute('data-state', 'unknown');
    await expect(page.locator('#gpu-note')).toBeVisible();
  });

  test('shows unknown when the status endpoint itself fails', async ({ page }) => {
    // The badge is a convenience; a failed poll must not surface as an error.
    await page.route('**/v1/status', (route) => route.fulfill({ status: 503, body: '' }));
    await page.goto('/');

    await expect(page.locator('#gpu-badge')).toHaveAttribute('data-state', 'unknown');
  });

  test('renders warming distinctly from both warm and cold', async ({ page }) => {
    await mockStatus(page, {
      gemma: 'warming',
      warmup_requested_at: new Date().toISOString(),
    });
    await page.goto('/');

    const badge = page.locator('#gpu-badge');
    await expect(badge).toHaveAttribute('data-state', 'warming');
    // The label carries the state on its own, so the badge does not rely on
    // colour or on the pulse animation to say what is happening.
    await expect(badge).toHaveText(/warming/i);

    // The note has to name the wait, which is the reason the state exists.
    const note = page.locator('#gpu-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText(/2 minutes/i);
    await expect(note).toContainText(/starting up/i);
  });

  test('holds the warm-up button disabled while the fleet is warming', async ({ page }) => {
    await mockStatus(page, { gemma: 'warming', warmup_requested_at: new Date().toISOString() });
    await page.goto('/');

    const button = page.locator('#warmup');
    // Pressing again while a boot is already under way would spend nothing and
    // teach the user the button does not work.
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveText(/starting/i);
  });

  test('flips from cold to warming when the warm-up is pressed', async ({ page }) => {
    const state = { gemma: 'cold' };
    await mockStatusSequence(page, state);
    await page.route('**/v1/warmup', (route) => {
      // What the server does on a wake: the next status poll reports warming.
      state.gemma = 'warming';
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ started: true }),
      });
    });

    await page.goto('/');
    await expect(page.locator('#gpu-badge')).toHaveAttribute('data-state', 'cold');
    await expect(page.locator('#warmup')).toBeEnabled();

    await page.click('#warmup');

    // The press is acknowledged immediately, and the badge follows on the poll
    // that the click triggers — this is the feedback the button previously
    // lacked entirely.
    await expect(page.locator('#warmup')).toBeDisabled();
    await expect(page.locator('#gpu-badge')).toHaveAttribute('data-state', 'warming');
  });

  test('releases the button and stops warning once the fleet turns warm', async ({ page }) => {
    const state = { gemma: 'warming' };
    await mockStatusSequence(page, state);
    await page.goto('/');

    await expect(page.locator('#warmup')).toBeDisabled();

    // The boot lands; the 5s warming poll is what notices, without a reload.
    state.gemma = 'warm';

    await expect(page.locator('#gpu-badge')).toHaveAttribute('data-state', 'warm', {
      timeout: 15_000,
    });
    await expect(page.locator('#warmup')).toBeEnabled();
    await expect(page.locator('#warmup')).toHaveText(/warm up/i);
    await expect(page.locator('#gpu-note')).toBeHidden();
  });

  test('the warm-up button posts to /v1/warmup and re-polls', async ({ page }) => {
    await mockStatus(page, { gemma: 'cold' });

    let warmups = 0;
    await page.route('**/v1/warmup', (route) => {
      warmups += 1;
      return route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ started: true }),
      });
    });

    await page.goto('/');
    await expect(page.locator('#gpu-badge')).toHaveAttribute('data-state', 'cold');
    await page.click('#warmup');

    await expect.poll(() => warmups).toBe(1);
    // The note names the cost: the instance is billed while it lives.
    await expect(page.locator('#gpu-note')).toContainText(/billed/i);
  });
});

test.describe('the pipeline checklist', () => {
  test('shows the waking note when submitting while cold', async ({ page }) => {
    await mockStatus(page, { gemma: 'cold' });

    // The message this asserts is an *in-flight* state: it is replaced the
    // moment the first progress frame lands, and cleared when the answer
    // arrives. Against the mock fleet the whole pipeline finishes in a couple
    // of hundred milliseconds, so without holding the request open the
    // assertion is racing a message that has already been superseded — which is
    // a flaky test, not a broken UI. Releasing the request afterwards keeps the
    // rest of the flow real.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/v1/ask', async (route) => {
      await held;
      await route.continue();
    });

    await page.goto('/');
    await page.fill('#input', CUSTOMER_EMAIL);
    await page.click('#submit');

    // The GPU step is prepended only for a cold fleet, and the status line names
    // the wait so it does not read as a hang.
    await expect(page.locator('#steps .step[data-stage="gpu_wakeup"]')).toBeVisible();
    await expect(page.locator('#status')).toContainText(/waking the gpu/i);

    release?.();
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });
  });

  test('omits the GPU step when the fleet is already warm', async ({ page }) => {
    await mockStatus(page, { gemma: 'warm', last_active_at: new Date().toISOString() });
    await page.goto('/');
    await page.fill('#input', CUSTOMER_EMAIL);
    await page.click('#submit');

    await expect(page.locator('#progress')).toBeVisible();
    // A step that is always shown and usually instant teaches the reader to
    // ignore it, so it is absent when there is nothing to wait for.
    await expect(page.locator('#steps .step[data-stage="gpu_wakeup"]')).toHaveCount(0);
  });

  test('fills the steps in order and completes every one', async ({ page }) => {
    await mockStatus(page, { gemma: 'warm', last_active_at: new Date().toISOString() });
    await page.goto('/');
    await page.fill('#input', CUSTOMER_EMAIL);
    await page.click('#submit');

    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    for (const stage of ['masking', 'egress_guard', 'core_reasoning', 'leak_check', 'rehydrate']) {
      await expect(page.locator(`#steps .step[data-stage="${stage}"]`)).toHaveClass(/done/);
    }
    // Each step reports its own elapsed time, which is what turns a wait into
    // visible work.
    await expect(page.locator('#steps .step[data-stage="masking"] .step-time')).toContainText(/s$/);
  });

  test('marks the stage that refused and leaves the later ones unreached', async ({ page }) => {
    await mockStatus(page, { gemma: 'warm', last_active_at: new Date().toISOString() });
    await page.goto('/');
    await page.fill('#input', `${LEAK_MARKER} ${CUSTOMER_EMAIL}`);
    await page.click('#submit');

    await expect(page.locator('#blocked')).toBeVisible({ timeout: 30_000 });

    // The gate that refused is the one fact worth showing: it is marked stopped,
    // and `rehydrate` stays pending because it was never reached — a different
    // fact from having failed.
    await expect(page.locator('#steps .step[data-stage="leak_check"]')).toHaveClass(/stopped/);
    await expect(page.locator('#steps .step[data-stage="rehydrate"]')).toHaveClass(/pending/);
    await expect(page.locator('#steps .step[data-stage="core_reasoning"]')).toHaveClass(/done/);
  });
});

test.describe('a dispatched warm-up outranks a stale cold reading', () => {
  test('keeps the starting note and the cost warning across the next poll', async ({ page }) => {
    // The server accepts the wake immediately but keeps reporting `cold` until
    // the instance actually starts booting. The very next poll must not undo
    // what the user was just told, or the cost warning disappears at exactly
    // the moment billing begins.
    await mockStatus(page, { gemma: 'cold' });
    await page.route('**/v1/warmup', (route) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ started: true }),
      }),
    );

    await page.goto('/');
    await expect(page.locator('#gpu-badge')).toHaveAttribute('data-state', 'cold');
    await page.click('#warmup');

    await expect(page.locator('#gpu-note')).toContainText(/starting up/i);
    await expect(page.locator('#gpu-note')).toContainText(/billed/i);

    // Several polls later, with the server still saying `cold`, the message has
    // not reverted to "the GPU is asleep".
    await page.waitForTimeout(1200);
    await expect(page.locator('#gpu-note')).toContainText(/starting up/i);
    await expect(page.locator('#gpu-note')).not.toContainText(/asleep/i);
    await expect(page.locator('#warmup')).toBeDisabled();
  });

  test('releases the flag as soon as the server catches up', async ({ page }) => {
    const state = { gemma: 'cold' as string };
    await page.route('**/v1/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ gemma: state.gemma, cold_start_estimate_seconds: 120 }),
      }),
    );
    await page.route('**/v1/warmup', (route) =>
      route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({ started: true }),
      }),
    );

    await page.goto('/');
    await page.click('#warmup');
    await expect(page.locator('#gpu-note')).toContainText(/starting up/i);

    // Any status other than `cold` is the server having caught up, so the flag
    // is spent rather than expiring on a timer of its own.
    state.gemma = 'warm';
    await expect(page.locator('#gpu-note')).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('#warmup')).toBeEnabled();
  });
});

test.describe('the checklist shows the request moving', () => {
  test('counts the elapsed seconds up on the step in flight', async ({ page }) => {
    await mockStatus(page, { gemma: 'cold' });
    await page.goto('/');
    await page.fill('#input', CUSTOMER_EMAIL);
    await page.click('#submit');

    // Every finished step carries the time it took, so the checklist reports
    // duration rather than only order.
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#steps .step.done .step-time').first()).toHaveText(/\d+\.\d+s/);
  });

  test('marks each step done as the pipeline advances', async ({ page }) => {
    await mockStatus(page, { gemma: 'warm', last_active_at: new Date().toISOString() });
    await page.goto('/');
    await page.fill('#input', CUSTOMER_EMAIL);
    await page.click('#submit');
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    // Every stage completed, and each one says so with a check rather than only
    // with a colour.
    const done = page.locator('#steps .step.done');
    await expect(done).toHaveCount(5);
    await expect(done.first().locator('.step-mark')).toHaveText('✓');
  });

  test('holds no live-update timer once the run has finished', async ({ page }) => {
    await mockStatus(page, { gemma: 'warm', last_active_at: new Date().toISOString() });
    await page.goto('/');
    await page.fill('#input', CUSTOMER_EMAIL);
    await page.click('#submit');
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    // A settled checklist must stop repainting: the times are final, and a timer
    // left running would keep a finished page busy for nothing.
    const settled = await page.locator('#steps').innerHTML();
    await page.waitForTimeout(400);
    expect(await page.locator('#steps').innerHTML()).toBe(settled);
  });

  test('falls back to a still checklist under reduced motion', async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();
    await mockStatus(page, { gemma: 'warm', last_active_at: new Date().toISOString() });
    await page.goto('/');
    await page.fill('#input', CUSTOMER_EMAIL);
    await page.click('#submit');
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    // No sweeping gradient anywhere, and the marks and times still carry the
    // whole message — what the setting removes is decoration, not information.
    await expect(page.locator('#steps .step-shimmer')).toHaveCount(0);
    await expect(page.locator('#steps .step.done')).toHaveCount(5);
    await expect(page.locator('#steps .step.done .step-time').first()).toHaveText(/\d+\.\d+s/);
    await context.close();
  });
});
