/** What the English submission video shows about the browser workflow. */

import { expect, test, type Page } from '@playwright/test';

const REQUEST =
  'Customer Taro Yamada at taro@example.co.jp reports that the card 4242 4242 4242 4242 failed for Titan Project. Draft a concise reply.';

async function pause(page: Page, milliseconds: number): Promise<void> {
  await page.waitForTimeout(milliseconds);
}

async function installPresentationLayer(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      html { scroll-behavior: smooth; }
      body { padding-bottom: 7rem; }
      #demo-caption {
        position: fixed;
        z-index: 10000;
        left: 50%;
        bottom: 2rem;
        transform: translateX(-50%);
        width: min(86vw, 1400px);
        padding: 1rem 1.5rem;
        border: 1px solid rgb(255 255 255 / 24%);
        border-radius: 0.75rem;
        background: rgb(7 10 18 / 92%);
        box-shadow: 0 1rem 3rem rgb(0 0 0 / 45%);
        color: #f8fafc;
        font: 600 1.6rem/1.35 ui-sans-serif, system-ui, sans-serif;
        text-align: center;
        backdrop-filter: blur(12px);
      }
      #demo-title {
        position: fixed;
        z-index: 10001;
        inset: 0;
        display: grid;
        place-content: center;
        gap: 1rem;
        padding: 8rem;
        background: radial-gradient(circle at 50% 30%, #172554, #070a12 65%);
        color: white;
        text-align: center;
      }
      #demo-title h2 { margin: 0; font-size: 4.5rem; line-height: 1.05; }
      #demo-title p { margin: 0; color: #93c5fd; font-size: 2rem; }
    `,
  });

  await page.evaluate(() => {
    const captionElement = document.createElement('div');
    captionElement.id = 'demo-caption';
    captionElement.setAttribute('aria-live', 'polite');
    captionElement.hidden = true;
    document.body.append(captionElement);

    const title = document.createElement('section');
    title.id = 'demo-title';
    title.innerHTML =
      '<h2>Privacy-Preserving<br>Multi-Agent Gateway</h2>' +
      '<p>Gemma masks. Gemini reasons. Deterministic checks decide release.</p>';
    document.body.append(title);
  });
}

async function caption(page: Page, text: string): Promise<void> {
  await page.locator('#demo-caption').evaluate((element, value) => {
    element.textContent = String(value);
    (element as HTMLElement).hidden = false;
  }, text);
}

test('records the privacy gateway workflow in English', async ({ page }) => {
  await page.goto('/');
  await installPresentationLayer(page);
  await pause(page, 3_500);
  await page.locator('#demo-title').evaluate((element) => element.remove());

  await caption(
    page,
    'Start with a normal request — including identifiers and a private codename.',
  );
  await page.locator('#input').pressSequentially(REQUEST, { delay: 12 });
  await pause(page, 1_500);

  await caption(
    page,
    'Shape-based detectors find identifiers. You can explicitly protect secrets with no recognizable shape.',
  );
  await page.locator('#mask-terms').pressSequentially('Titan Project', { delay: 55 });
  await expect(page.locator('#mask-terms-preview')).toContainText('Titan Project');
  await pause(page, 2_500);

  await caption(
    page,
    'High-risk values stay withheld by default. Every disclosure is explicit and limited to one request.',
  );
  await page.locator('.disclosure').scrollIntoViewIfNeeded();
  await pause(page, 3_000);

  await caption(page, 'Send the request through the fail-closed gateway.');
  await page.locator('#submit').scrollIntoViewIfNeeded();
  await pause(page, 1_000);
  await page.locator('#submit').click();
  await expect(page.locator('#results')).toBeVisible({ timeout: 30_000 });

  await caption(
    page,
    'The release shows four independent trust dimensions — never one misleading score.',
  );
  await page.locator('#dimensions').scrollIntoViewIfNeeded();
  await pause(page, 4_500);

  await caption(
    page,
    'This is pseudonymization, not anonymization: placeholders still reveal category and equality.',
  );
  await page.locator('#legend-section').scrollIntoViewIfNeeded();
  await expect(page.locator('#legend-note')).toContainText('not anonymization');
  await pause(page, 4_500);

  await caption(
    page,
    'The left pane stays inside the boundary. Only typed placeholders are sent to Gemini.',
  );
  await page.locator('#masked').scrollIntoViewIfNeeded();
  await expect(page.locator('#masked')).toContainText('⟦EMAIL_1⟧');
  await expect(page.locator('#masked')).toContainText('⟦CUSTOM_1⟧');
  await pause(page, 4_500);

  await caption(page, 'Click a placeholder to trace the same protected value across the workflow.');
  await page.locator('#masked .pii-chip[data-token="⟦EMAIL_1⟧"]').first().click();
  await pause(page, 3_500);

  await caption(
    page,
    'Safe values are rehydrated once for the caller. Card data remains withheld by policy.',
  );
  await page.locator('#answer').scrollIntoViewIfNeeded();
  await expect(page.locator('#answer')).toContainText('taro@example.co.jp');
  await expect(page.locator('#answer .pii-chip.withheld').first()).toBeVisible();
  await pause(page, 4_500);

  await caption(
    page,
    'Every released answer carries an OKF v0.2 audit record and deterministic leak-check evidence.',
  );
  await page.locator('summary').scrollIntoViewIfNeeded();
  await page.locator('summary').click();
  await expect(page.locator('#okf')).toContainText('type: Gateway Answer');
  await pause(page, 5_000);

  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
  await caption(
    page,
    'Privacy-Preserving Gateway — useful answers, inspectable evidence, and no unsafe fallback.',
  );
  await pause(page, 5_000);
});
