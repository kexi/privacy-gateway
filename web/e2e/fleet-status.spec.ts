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
  body: { gemma: string; last_active_at?: string; cold_start_estimate_seconds?: number },
): Promise<void> {
  await page.route('**/v1/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ cold_start_estimate_seconds: 120, ...body }),
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
    await page.goto('/');
    await page.fill('#input', CUSTOMER_EMAIL);
    await page.click('#submit');

    // The GPU step is prepended only for a cold fleet, and the status line names
    // the wait so it does not read as a hang.
    await expect(page.locator('#steps .step[data-stage="gpu_wakeup"]')).toBeVisible();
    await expect(page.locator('#status')).toContainText(/waking the gpu/i);

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
