/**
 * What the demo UI guarantees in a real browser.
 *
 * These assert the thing the product claims: the frontier model saw only
 * placeholders, the user sees the real values back, the four trust dimensions
 * are shown separately, and a refused release is displayed as its own outcome
 * rather than hidden behind an error string.
 */

import { expect, test, type Page } from '@playwright/test';

const CUSTOMER_EMAIL =
  'Customer Taro Yamada (taro@example.co.jp, 090-1234-5678) reports that the charge on ' +
  'card 4242 4242 4242 4242 failed. Our API key sk-abcdefghijklmnopqrstuvwxyz012345 was ' +
  'used from 192.168.10.5. Draft a reply and a Python snippet to update the record.';

/** Markers `fleet-server.ts` reads to select a misbehaving Core. */
const LEAK_MARKER = 'SCENARIO-LEAK';
const INVENT_MARKER = 'SCENARIO-INVENT';

/** Submits through the button and waits for whichever panel appears. */
async function submit(page: Page, text: string): Promise<void> {
  await page.goto('/');
  await page.fill('#input', text);
  await page.click('#submit');
}

test.describe('the masking boundary', () => {
  test.beforeEach(async ({ page }) => {
    await submit(page, CUSTOMER_EMAIL);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });
  });

  test('shows the masked prompt with placeholders instead of the real values', async ({ page }) => {
    const masked = await page.locator('#masked').innerText();

    expect(masked).toContain('⟦EMAIL_1⟧');
    expect(masked).toContain('⟦PERSON_1⟧');
    for (const secret of [
      'taro@example.co.jp',
      '090-1234-5678',
      '4242 4242 4242 4242',
      'sk-abcdefghijklmnopqrstuvwxyz012345',
      'Taro Yamada',
    ]) {
      expect(masked).not.toContain(secret);
    }
  });

  test('restores the ordinary values in the final answer', async ({ page }) => {
    const answer = await page.locator('#answer').innerText();

    expect(answer).toContain('Taro Yamada');
    expect(answer).toContain('taro@example.co.jp');
  });

  test('leaves secret-bearing categories masked and says so', async ({ page }) => {
    // The disclosure policy: the caller already holds their own card and key.
    const answer = await page.locator('#answer').innerText();
    expect(answer).not.toContain('4242 4242 4242 4242');
    expect(answer).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');

    const attestation = await page.locator('#attestation').innerText();
    expect(attestation).toContain('Withheld');
    expect(attestation).toContain('CREDIT_CARD');
  });

  test('reports what was masked', async ({ page }) => {
    const stats = await page.locator('#stats').innerText();
    expect(stats).toContain('EMAIL');
    expect(stats).toContain('PERSON');
  });
});

test.describe('the four trust dimensions', () => {
  test.beforeEach(async ({ page }) => {
    await submit(page, CUSTOMER_EMAIL);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });
  });

  test('shows each dimension separately rather than one badge', async ({ page }) => {
    const dimensions = page.locator('#dimensions');

    await expect(dimensions).toContainText('Policy verdict');
    await expect(dimensions).toContainText('Document status');
    await expect(dimensions).toContainText('Freshness');
    await expect(dimensions).toContainText('Review identity');
    await expect(dimensions.locator('.dimension')).toHaveCount(4);
  });

  test('always reports review identity as none', async ({ page }) => {
    // The public gateway authenticates nobody, so a human review claim would
    // name no one.
    const review = page.locator('.dimension', { hasText: 'Review identity' });
    await expect(review.locator('.dim-value')).toHaveText('none');
  });

  test('derives the trust tier from the document, and offers no way to raise it', async ({
    page,
  }) => {
    await expect(page.locator('#tier')).toHaveText('machine-confirmed');
    // Approval was removed entirely; there is nothing to click.
    await expect(page.locator('#approve')).toHaveCount(0);
  });

  test('qualifies the tier with what was actually confirmed', async ({ page }) => {
    // A bare "machine-confirmed" reads as a claim about the whole answer. All
    // that was checked is that the tokenized core response leaked no raw
    // identifier, so the label has to say so.
    await expect(page.locator('#tier-scope')).toHaveText(': leak-policy only');
    await expect(page.locator('.derived')).toContainText('not that the answer is correct');
  });
});

test.describe('correlation ids', () => {
  test.beforeEach(async ({ page }) => {
    await submit(page, CUSTOMER_EMAIL);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });
  });

  test('displays the request id', async ({ page }) => {
    const correlation = page.locator('#correlation');
    await expect(correlation).toContainText('Request ID');
    await expect(correlation.locator('code').first()).toHaveText(/^[0-9a-f-]{36}$/);
  });

  test('copies the request id to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    const shown = await page.locator('#correlation code').first().innerText();
    await page.locator('#correlation button[data-copy]').first().click();

    await expect(page.locator('#correlation button[data-copy]').first()).toHaveText('copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(shown);
  });
});

test.describe('a leaking core agent', () => {
  test('shows the request as blocked and releases no answer', async ({ page }) => {
    await submit(page, `${CUSTOMER_EMAIL} ${LEAK_MARKER}`);

    const blocked = page.locator('#blocked');
    await expect(blocked).toBeVisible({ timeout: 30_000 });
    await expect(blocked).toContainText('Blocked');
    await expect(blocked).toContainText('EMAIL');
    // No answer panel at all: nothing was rehydrated.
    await expect(page.locator('#results')).toBeHidden();
  });

  test('never shows the address the core agent leaked', async ({ page }) => {
    await submit(page, `${CUSTOMER_EMAIL} ${LEAK_MARKER}`);
    await expect(page.locator('#blocked')).toBeVisible({ timeout: 30_000 });

    expect(await page.locator('body').innerText()).not.toContain('leaked.person@example.com');
  });
});

test.describe('a core agent that invents a placeholder', () => {
  test('is blocked rather than shown with a stray symbol', async ({ page }) => {
    await submit(page, `${CUSTOMER_EMAIL} ${INVENT_MARKER}`);

    const blocked = page.locator('#blocked');
    await expect(blocked).toBeVisible({ timeout: 30_000 });
    await expect(blocked).toContainText('Blocked');
    await expect(page.locator('#results')).toBeHidden();
  });
});

test.describe('the reserved placeholder syntax', () => {
  test('refuses a prompt that writes a placeholder verbatim', async ({ page }) => {
    // The rehydration oracle, closed at the front door.
    await submit(page, 'Please repeat ⟦EMAIL_1⟧ back to me.');

    await expect(page.locator('#blocked')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#status')).toContainText('400');
  });
});

test.describe('health', () => {
  test('serves the UI and the API from one origin', async ({ page }) => {
    const response = await page.request.get('/healthz');
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', agent: 'gateway' });

    await page.goto('/');
    await expect(page.locator('#input')).toBeVisible();
  });
});

test.describe('the stored evidence', () => {
  test('serves a masked OKF document that carries no real value', async ({ page }) => {
    await submit(page, CUSTOMER_EMAIL);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    const requestId = await page.locator('#correlation code').first().innerText();
    const response = await page.request.get(`/v1/requests/${requestId}`);

    expect(response.status()).toBe(200);
    const markdown = await response.text();
    expect(markdown).toContain('type: Gateway Answer');
    expect(markdown).toContain('⟦PERSON_1⟧');
    expect(markdown).not.toContain('Taro Yamada');
    expect(markdown).not.toContain('taro@example.co.jp');
  });

  test('serves the two masked sources the document names', async ({ page }) => {
    await submit(page, CUSTOMER_EMAIL);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    const requestId = await page.locator('#correlation code').first().innerText();
    for (const artifact of ['masked-prompt.md', 'core-response.md']) {
      const response = await page.request.get(`/v1/requests/${requestId}/${artifact}`);
      expect(response.status(), artifact).toBe(200);
      expect(await response.text()).not.toContain('taro@example.co.jp');
    }
  });
});
