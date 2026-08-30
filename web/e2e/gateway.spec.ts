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

/** Submits with the verbatim-mask terms box filled in as well. */
async function submitWithTerms(page: Page, text: string, terms: string): Promise<void> {
  await page.goto('/');
  await page.fill('#input', text);
  await page.fill('#mask-terms', terms);
  await page.click('#submit');
}

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

test.describe('what was masked', () => {
  test.beforeEach(async ({ page }) => {
    await submit(page, CUSTOMER_EMAIL);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });
  });

  test('lists every detected category with its count, in text', async ({ page }) => {
    // The legend is the fallback for everything the colours cannot say, so the
    // category name and the count are asserted as text rather than as styling.
    const legend = page.locator('#legend');
    await expect(legend.locator('.legend-row')).not.toHaveCount(0);

    const email = legend.locator('.legend-row', { hasText: 'EMAIL' }).first();
    await expect(email.locator('.legend-name')).toHaveText('EMAIL');
    await expect(email.locator('.legend-count')).toHaveText(/^\d+ masked$/);

    await expect(legend).toContainText('PERSON');
    await expect(legend).toContainText('CREDIT_CARD');
  });

  test('names the masking as pseudonymization rather than anonymization', async ({ page }) => {
    await expect(page.locator('#legend-note')).toContainText('not anonymization');
  });

  test('shows the request you typed and highlights the email span in it', async ({ page }) => {
    const original = page.locator('#original');
    await expect(original).toContainText('taro@example.co.jp');

    const supported = await page.evaluate(() => 'highlights' in CSS);
    test.skip(!supported, 'this browser has no CSS Custom Highlight API');

    // The registry is the observable output: the painter registers one entry per
    // category, and the email span is the one this test cares about.
    const highlighted = await page.evaluate(() => {
      const email = CSS.highlights.get('pii-email');
      if (email === undefined) return null;
      return [...email].map((range) => range.toString());
    });
    expect(highlighted).toContain('taro@example.co.jp');
  });

  test('renders each placeholder in the masked prompt as a labelled chip', async ({ page }) => {
    const chip = page.locator('#masked .pii-chip[data-token="⟦EMAIL_1⟧"]').first();

    await expect(chip).toBeVisible();
    // The label is text: the colour repeats it, never replaces it.
    await expect(chip).toContainText('EMAIL');
    await expect(chip).toContainText('1');
  });

  test('highlights the restored value in the answer, closing the loop', async ({ page }) => {
    const supported = await page.evaluate(() => 'highlights' in CSS);
    test.skip(!supported, 'this browser has no CSS Custom Highlight API');

    // The chips inserted into the answer carry the placeholder verbatim, so the
    // pane's text still concatenates to the answer string and the offsets line
    // up. A shortened chip label would land these ranges on the wrong words.
    const inAnswer = await page.evaluate(() => {
      const pane = document.getElementById('answer');
      if (pane === null) return null;
      const found: string[] = [];
      for (const [name, highlight] of CSS.highlights) {
        if (!name.startsWith('pii-')) continue;
        for (const range of highlight) {
          if (pane.contains(range.startContainer)) found.push(range.toString());
        }
      }
      return found;
    });
    expect(inAnswer).toContain('taro@example.co.jp');
  });

  test('marks a withheld category in the answer with the reason', async ({ page }) => {
    // A withheld placeholder is still in the answer text, so the chip is what
    // tells the reader the gap is policy rather than a failure.
    const withheld = page.locator('#answer .pii-chip.withheld').first();

    await expect(withheld).toBeVisible();
    await expect(withheld).toHaveAttribute('title', 'withheld by policy');
  });

  test('emphasises the linked spans everywhere when a chip is clicked', async ({ page }) => {
    const supported = await page.evaluate(() => 'highlights' in CSS);
    test.skip(!supported, 'this browser has no CSS Custom Highlight API');

    await page.locator('#masked .pii-chip[data-token="⟦EMAIL_1⟧"]').first().click();

    // The emphasis moves the ranges into a second registry entry, which is what
    // `::highlight(pii-email-linked)` styles.
    const linked = await page.evaluate(() => {
      const entry = CSS.highlights.get('pii-email-linked');
      return entry === undefined ? null : [...entry].map((range) => range.toString());
    });
    expect(linked).toContain('taro@example.co.jp');

    // Every chip for that placeholder reports itself as pressed, so the state is
    // not carried by colour alone.
    await expect(
      page.locator('.pii-chip[data-token="⟦EMAIL_1⟧"][aria-pressed="true"]').first(),
    ).toBeVisible();
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

test.describe('the disclosure opt-in', () => {
  test('offers every high-risk category, all unchecked', async ({ page }) => {
    await page.goto('/');

    // The safe policy has to be what happens when nobody chooses, so every box
    // starts off. A pre-checked disclosure would be a disclosure by default.
    for (const category of ['CREDIT_CARD', 'API_KEY', 'JWT', 'AWS_KEY', 'MY_NUMBER']) {
      const box = page.locator(`input[name="rehydrate_allow"][value="${category}"]`);
      await expect(box).toBeVisible();
      await expect(box).not.toBeChecked();
    }
  });

  test('groups the boxes under a legend and warns what allowing means', async ({ page }) => {
    await page.goto('/');

    await expect(page.locator('fieldset.disclosure legend')).toHaveText(/Allow high-risk values/);
    await expect(page.locator('#disclosure-warning')).toContainText(
      /only the values this request submitted/,
    );
    // The warning is announced with the control, not merely printed near it.
    await expect(
      page.locator('input[name="rehydrate_allow"][value="CREDIT_CARD"]'),
    ).toHaveAttribute('aria-describedby', 'disclosure-warning');
  });

  test('labels every box so the control is reachable by its text', async ({ page }) => {
    await page.goto('/');

    // Clicking the label must toggle the box, which is only true when `for` and
    // `id` actually pair up.
    const card = page.locator('input[name="rehydrate_allow"][value="CREDIT_CARD"]');
    await page.click('label[for="allow-credit-card"]');
    await expect(card).toBeChecked();
  });

  test('withholds the card as a chip when nothing is allowed', async ({ page }) => {
    await submit(page, CUSTOMER_EMAIL);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    const answer = await page.locator('#answer').innerText();
    expect(answer).toContain('⟦CREDIT_CARD_1⟧');
    expect(answer).not.toContain('4242 4242 4242 4242');
    await expect(page.locator('#answer .pii-chip.withheld')).not.toHaveCount(0);
  });

  test('restores the card into the answer when the box is checked', async ({ page }) => {
    await page.goto('/');
    await page.fill('#input', CUSTOMER_EMAIL);
    await page.check('input[name="rehydrate_allow"][value="CREDIT_CARD"]');
    await page.click('#submit');
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    const answer = await page.locator('#answer').innerText();
    expect(answer).toContain('4242 4242 4242 4242');
    expect(answer).not.toContain('⟦CREDIT_CARD_1⟧');
  });

  test('highlights the restored card rather than showing a withheld chip', async ({ page }) => {
    await page.goto('/');
    await page.fill('#input', CUSTOMER_EMAIL);
    await page.check('input[name="rehydrate_allow"][value="CREDIT_CARD"]');
    await page.click('#submit');
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    // The card is now a restored value like any other, so it is painted by the
    // same highlight machinery — and the withheld chip for it is gone.
    await expect(
      page.locator('#answer .pii-chip.withheld[data-category="CREDIT_CARD"]'),
    ).toHaveCount(0);
    await expect(page.locator('#attestation .withheld')).not.toContainText('CREDIT_CARD');
  });

  test('still withholds a category the user did not check', async ({ page }) => {
    await page.goto('/');
    await page.fill('#input', CUSTOMER_EMAIL);
    await page.check('input[name="rehydrate_allow"][value="CREDIT_CARD"]');
    await page.click('#submit');
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    const answer = await page.locator('#answer').innerText();
    expect(answer).toContain('⟦API_KEY_1⟧');
    expect(answer).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  test('records the opt-in in the OKF document', async ({ page }) => {
    await page.goto('/');
    await page.fill('#input', CUSTOMER_EMAIL);
    await page.check('input[name="rehydrate_allow"][value="CREDIT_CARD"]');
    await page.click('#submit');
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    // `textContent`, not `innerText`: the document lives inside a collapsed
    // `<details>`, so nothing here is rendered until someone opens it.
    const okf = (await page.locator('#okf').textContent()) ?? '';
    expect(okf).toContain('disclosure_requested');
    expect(okf).toContain('CREDIT_CARD');
    // The audit record still holds only the masked body: the disclosure was for
    // the one response, never for the stored evidence.
    expect(okf).not.toContain('4242 4242 4242 4242');
  });
});

test.describe('user-defined secret terms', () => {
  const CODENAME = 'Titan Project';
  const WITH_CODENAME = `Summarize the status of ${CODENAME} for the board, in two lines.`;

  test('previews the parsed terms as chips before anything is sent', async ({ page }) => {
    await page.goto('/');
    await page.fill('#mask-terms', 'Titan Project, Hummingbird');

    // The echo is the confirmation that the comma-separated box was read the way
    // the user meant. Believing a term was masked when it was not is the whole
    // failure mode this field has.
    await expect(page.locator('#mask-terms-preview li')).toHaveCount(2);
    await expect(page.locator('#mask-terms-preview li').first()).toHaveText('Titan Project');
  });

  test('marks a term the schema would reject rather than sending it', async ({ page }) => {
    await page.goto('/');
    await page.fill('#mask-terms', 'a');

    await expect(page.locator('#mask-terms-preview li.invalid')).toHaveCount(1);
  });

  test('masks the term in the prompt the frontier model receives', async ({ page }) => {
    await submitWithTerms(page, WITH_CODENAME, CODENAME);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    const masked = await page.locator('#masked').innerText();
    expect(masked).not.toContain(CODENAME);
    expect(masked).toContain('⟦CUSTOM_1⟧');
  });

  test('shows the CUSTOM placeholder as a chip in the masked pane', async ({ page }) => {
    await submitWithTerms(page, WITH_CODENAME, CODENAME);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    // The alignment and highlight machinery picks CUSTOM up through the shared
    // category map, exactly as it does every detected category.
    await expect(page.locator('#masked .pii-chip[data-category="CUSTOM"]')).not.toHaveCount(0);
  });

  test('lists CUSTOM in the legend with its count', async ({ page }) => {
    await submitWithTerms(page, WITH_CODENAME, CODENAME);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    await expect(page.locator('#legend .legend-row[data-category="CUSTOM"]')).toHaveCount(1);
  });

  test('restores the term in the answer, because the requester supplied it', async ({ page }) => {
    await submitWithTerms(page, WITH_CODENAME, CODENAME);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    // CUSTOM is deliberately not withheld: the requester already holds the term,
    // so withholding protects nothing and makes the answer unreadable.
    const answer = await page.locator('#answer').innerText();
    expect(answer).toContain(CODENAME);
    expect(answer).not.toContain('⟦CUSTOM_1⟧');
  });

  test('never writes the term into the stored evidence', async ({ page }) => {
    await submitWithTerms(page, WITH_CODENAME, CODENAME);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    const requestId = await page.locator('#correlation code').first().innerText();

    // The evidence routes are unauthenticated. A codename written into any of
    // the three would be a leak of exactly the thing the requester asked to hide.
    for (const path of ['', '/masked-prompt.md', '/core-response.md']) {
      const response = await page.request.get(`/v1/requests/${requestId}${path}`);
      expect(response.status(), path).toBe(200);
      expect(await response.text(), path).not.toContain(CODENAME);
    }
  });

  test('shows the term count in the attestation panel, never a term', async ({ page }) => {
    await submitWithTerms(page, WITH_CODENAME, CODENAME);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    const attestation = await page.locator('#attestation').innerText();
    expect(attestation).toContain('Requester-named terms scanned for');
    expect(attestation).not.toContain(CODENAME);
  });

  test('records only the term count in the OKF document', async ({ page }) => {
    await submitWithTerms(page, WITH_CODENAME, CODENAME);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    // `textContent`: the document sits inside a collapsed <details>.
    const okf = (await page.locator('#okf').textContent()) ?? '';
    expect(okf).toContain('custom_terms');
    expect(okf).toContain('count: 1');
    expect(okf).not.toContain(CODENAME);
  });

  test('leaves an ordinary request untouched when no terms are named', async ({ page }) => {
    await submit(page, WITH_CODENAME);
    await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

    // Nothing detects a codename, so without the opt-in it crosses the boundary
    // in the clear. That is the gap the feature exists to close, stated as a test
    // so the two halves cannot be confused for each other.
    const masked = await page.locator('#masked').innerText();
    expect(masked).toContain(CODENAME);
  });
});
