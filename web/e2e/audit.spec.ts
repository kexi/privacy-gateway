/**
 * What the read-only audit view guarantees in a real browser.
 *
 * Three claims are asserted here rather than in a unit test, because all three
 * are about what a judge actually sees. The token gate must keep the table
 * empty until a token is accepted, and must say so in a way that does not
 * distinguish "wrong token" from "feature disabled" — the endpoint refuses to
 * tell the two apart, and a UI that guessed would undo that. The table must
 * render one row per stored document with its status, tier and verdict legible
 * as chips. And opening a row must show the OKF frontmatter as labelled facts,
 * because reading recorded claims one by one is the entire purpose of the page.
 *
 * `/v1/audit` and `/v1/requests/<id>` are served from route mocks: the fleet
 * booted by `fleet-server.ts` has no `ADMIN_TOKEN`, so the audit endpoint does
 * not exist there, and the point under test is the page rather than the gate's
 * server half (which `agents/gateway/test/audit.test.ts` covers directly).
 */

import { expect, test, type Page } from '@playwright/test';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const REQUEST_ID = '01920000-0000-7000-8000-000000000001';
const OLDER_REQUEST_ID = '01910000-0000-7000-8000-000000000000';
const TRACE_ID = 'f'.repeat(32);

/** Two rows: one released document and one that failed its attestation. */
const ENTRIES = [
  {
    request_id: REQUEST_ID,
    trace_id: TRACE_ID,
    created_at: '2026-08-30T10:00:00Z',
    stale_after: '2026-08-30T11:00:00Z',
    status: 'stable',
    trust_tier: 'machine-confirmed',
    freshness: 'fresh',
    attestation_verdict: 'pass',
    counts_by_category: { EMAIL: 1, PHONE: 2 },
    masked_count: 3,
    judge_retries: 0,
    withheld: ['CREDIT_CARD'],
  },
  {
    request_id: OLDER_REQUEST_ID,
    created_at: '2026-08-30T09:00:00Z',
    stale_after: '2026-08-30T10:00:00Z',
    status: 'draft',
    trust_tier: 'unverified',
    freshness: 'stale',
    attestation_verdict: 'fail',
    counts_by_category: {},
    masked_count: 0,
    judge_retries: 2,
    withheld: [],
  },
];

/** A stored OKF `Gateway Answer`, as `/v1/requests/<id>` serves it. */
const OKF_DOCUMENT = `---
type: Gateway Answer
title: Gateway answer for request ${REQUEST_ID}
request_id: ${REQUEST_ID}
trace_id: ${TRACE_ID}
status: stable
generated:
  by: synthesis_agent/0.1.0
  at: 2026-08-30T10:00:00Z
verified:
  - by: process:leak-check@a1b2c3d4e5f6
    at: 2026-08-30T10:00:03Z
stale_after: 2026-08-30T11:00:00Z
attestation:
  computation: knowledge/computations/leak-check.md
  verdict: pass
  request_id: ${REQUEST_ID}
---

# Answer

The masked answer body, referring to ⟦EMAIL_1⟧.
`;

/**
 * Serve the audit endpoints, honouring the token the way the gateway does.
 *
 * The mock answers 404 for a wrong or missing token rather than 401, so the
 * spec exercises the same indistinguishability the real endpoint provides.
 */
async function mockAudit(page: Page): Promise<void> {
  await page.route('**/v1/audit*', (route) => {
    const presented = route.request().headers()['x-admin-token'] ?? '';
    if (presented !== TOKEN) {
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'not_found' }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ entries: ENTRIES, limit: 50 }),
    });
  });

  await page.route(`**/v1/requests/${REQUEST_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/markdown', body: OKF_DOCUMENT }),
  );
}

/** Opens the page with no token remembered from an earlier spec. */
async function openAudit(page: Page): Promise<void> {
  await mockAudit(page);
  await page.goto('/audit.html');
  await page.evaluate(() => {
    sessionStorage.clear();
  });
  await page.reload();
}

test.describe('audit view', () => {
  test('states that it is read-only and shows masked evidence only', async ({ page }) => {
    await openAudit(page);

    await expect(page.locator('.notice')).toHaveText(
      'Read-only audit view. All content is masked evidence; rehydrated answers are never stored.',
    );
  });

  test('shows no evidence until a token is accepted', async ({ page }) => {
    await openAudit(page);

    // The table is not merely empty: the whole section is absent, so nothing
    // about the stored evidence — not even how much of it there is — is
    // visible to a reader without the capability.
    await expect(page.locator('#list-section')).toBeHidden();
    await expect(page.locator('#audit-rows tr')).toHaveCount(0);
  });

  test('refuses a wrong token without revealing whether the view exists', async ({ page }) => {
    await openAudit(page);

    await page.fill('#token', 'not-the-token');
    await page.click('#unlock');

    // One message for both causes, mirroring the endpoint's own 404.
    await expect(page.locator('#gate-status')).toContainText(
      'That token was not accepted, or the audit view is disabled on this deployment.',
    );
    await expect(page.locator('#list-section')).toBeHidden();
  });

  test('renders one row per stored document once the token is accepted', async ({ page }) => {
    await openAudit(page);

    await page.fill('#token', TOKEN);
    await page.click('#unlock');

    await expect(page.locator('#list-section')).toBeVisible();
    await expect(page.locator('#audit-rows tr')).toHaveCount(2);
    await expect(page.locator('#list-count')).toHaveText('2 documents');

    const first = page.locator('#audit-rows tr').first();
    await expect(first.locator('.request-id')).toHaveText(REQUEST_ID);
    // Status, tier and verdict each get their own chip: the four dimensions are
    // never collapsed into a single badge, here or on the main page.
    await expect(first.locator('.chip')).toHaveText(['stable', 'machine-confirmed', 'pass']);
    await expect(first.locator('.count-chip')).toHaveText(['EMAIL ×1', 'PHONE ×2', 'CREDIT_CARD']);

    // A failed attestation is shown, not hidden (OKF §10.5).
    const second = page.locator('#audit-rows tr').nth(1);
    await expect(second.locator('.chip')).toHaveText(['draft', 'unverified', 'fail']);
  });

  test('remembers the token across a reload, then forgets it on request', async ({ page }) => {
    await openAudit(page);

    await page.fill('#token', TOKEN);
    await page.click('#unlock');
    await expect(page.locator('#audit-rows tr')).toHaveCount(2);

    await page.reload();
    await expect(page.locator('#audit-rows tr')).toHaveCount(2);

    await page.click('#forget');
    await expect(page.locator('#list-section')).toBeHidden();

    await page.reload();
    await expect(page.locator('#list-section')).toBeHidden();
  });

  test('accepts a token from the URL fragment and clears it immediately', async ({ page }) => {
    await mockAudit(page);
    await page.goto('/audit.html');
    await page.evaluate(() => {
      sessionStorage.clear();
    });

    // A fragment is never sent to the server, which is why the shareable link
    // uses `#key=` and not `?key=`: a query string is written verbatim into
    // Cloud Run's request log. `goto` to a URL differing only in the fragment
    // is a same-document navigation that would never re-run the page's boot, so
    // the link is opened the way a recipient really opens it — on a fresh load.
    await page.goto('about:blank');
    await page.goto(`/audit.html#key=${TOKEN}`);

    await expect(page.locator('#audit-rows tr')).toHaveCount(2);

    // Stripped from the address bar, so the capability does not survive in the
    // history or in any subsequent referrer.
    expect(new URL(page.url()).hash).toBe('');

    // The token itself never appeared in a request URL.
    const requestedUrls: string[] = [];
    page.on('request', (request) => requestedUrls.push(request.url()));
    await page.click('#refresh');
    await expect(page.locator('#audit-rows tr')).toHaveCount(2);
    expect(requestedUrls.some((url) => url.includes(TOKEN))).toBe(false);
  });

  test('opening a row shows the OKF frontmatter as labelled facts', async ({ page }) => {
    await openAudit(page);

    await page.fill('#token', TOKEN);
    await page.click('#unlock');
    await page.locator('#audit-rows tr').first().click();

    await expect(page.locator('#detail')).toBeVisible();
    await expect(page.locator('#detail-title')).toHaveText(REQUEST_ID);

    // Each recorded claim is its own term, not a YAML blob the reader must parse.
    const terms = page.locator('#detail-frontmatter dt');
    await expect(terms.filter({ hasText: 'type' })).toBeVisible();
    await expect(terms.filter({ hasText: 'verified' })).toBeVisible();
    await expect(terms.filter({ hasText: 'attestation' })).toBeVisible();

    const frontmatter = page.locator('#detail-frontmatter');
    await expect(frontmatter).toContainText('Gateway Answer');
    await expect(frontmatter).toContainText('process:leak-check@a1b2c3d4e5f6');
    await expect(frontmatter).toContainText('synthesis_agent/0.1.0');

    // The body is the masked answer, shown as text rather than rendered.
    await expect(page.locator('#detail-body')).toContainText('The masked answer body');

    // The two masked sources the document names are one click away, so its
    // provenance can be followed rather than taken on trust.
    const links = page.locator('#detail-links a');
    await expect(links.filter({ hasText: 'Masked prompt' })).toHaveAttribute(
      'href',
      `/v1/requests/${REQUEST_ID}/masked-prompt.md`,
    );
    await expect(links.filter({ hasText: 'Core response' })).toHaveAttribute(
      'href',
      `/v1/requests/${REQUEST_ID}/core-response.md`,
    );
  });
});
