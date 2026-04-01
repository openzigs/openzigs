import { test, expect } from '@playwright/test';

test('debug presenter page', async ({ page }) => {
  const requests: string[] = [];
  const responses: string[] = [];
  const errors: string[] = [];

  page.on('request', (req) => {
    // Track ALL non-static requests
    if (!req.url().includes('/_next/static') && !req.url().includes('/_next/image') && !req.url().includes('favicon')) {
      requests.push(`${req.method()} ${req.url()}`);
    }
  });
  page.on('response', (res) => {
    if (!res.url().includes('/_next/static') && !res.url().includes('/_next/image') && !res.url().includes('favicon')) {
      responses.push(`${res.status()} ${res.url()}`);
    }
  });
  page.on('pageerror', (err) => errors.push(err.message));

  // Spy on all fetch calls via initScript (runs before any page JS)
  await page.addInitScript(() => {
    const origFetch = window.fetch;
    const calls: string[] = [];
    // @ts-ignore
    window.__fetchCalls = calls;
    window.fetch = (...args) => {
      const u = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
      calls.push(u);
      console.log('[spy-fetch]', u);
      return origFetch.apply(window, args as Parameters<typeof origFetch>);
    };
  });

  // Navigate to real presentation (no mock) to confirm fetch fires at all
  await page.goto('/presenter/hX7VI_Aor1LH', { waitUntil: 'domcontentloaded', timeout: 15000 });
  // wait for any pending React-Query fetches
  await page.waitForTimeout(5000);

  const fetchCalls = await page.evaluate(() => (window as unknown as { __fetchCalls?: string[] }).__fetchCalls ?? []);

  const url = page.url();
  const title = await page.title();
  
  // Inspect runtime environment
  const runtimeInfo = await page.evaluate(() => ({
    origin: window.location.origin,
    href: window.location.href,
    apiBase: (window as unknown as Record<string, unknown>)['__NEXT_DATA__'] ? 'has __NEXT_DATA__' : 'no __NEXT_DATA__',
    queryCount: document.querySelectorAll('button').length,
  }));
  
  const bodyText = await page.evaluate(() => document.body.innerText);
  const buttons = await page.getByRole('button').allTextContents();

  console.log('=== URL ===', url);
  console.log('=== Title ===', title);
  console.log('=== Runtime Info ===', JSON.stringify(runtimeInfo));
  console.log('=== Body text ===', bodyText.substring(0, 300));
  console.log('=== Buttons ===', JSON.stringify(buttons));
  console.log('=== API Requests ===', requests);
  console.log('=== Fetch Spy Calls ===', fetchCalls);
  console.log('=== Errors ===', errors);

  // Force pass so we always see the output
  expect(url).toBeDefined();
});
