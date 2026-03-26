import { test } from '@playwright/test';

test('debug admin page full load', async ({ page }) => {
  const requests: string[] = [];
  const failed: string[] = [];
  page.on('request', (req) => requests.push(req.url()));
  page.on('requestfailed', (req) => failed.push(`${req.url()} - ${req.failure()?.errorText}`));
  page.on('console', (msg) => { if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text()); });

  await page.goto('/admin', { waitUntil: 'load', timeout: 20000 });
  await page.waitForTimeout(5000);
  
  const apiRequests = requests.filter(r => r.includes('/api/'));
  console.log('API requests:', JSON.stringify(apiRequests, null, 2));
  console.log('Failed requests:', JSON.stringify(failed, null, 2));
  
  // Check if React hydrated by looking for interactive state
  const buttons = await page.getByRole('button').count();
  console.log('Button count:', buttons);
  
  // Check if any platform badge appeared
  const content = await page.content();
  console.log('Has Available badge:', content.includes('Available'));
  console.log('Has Loading text:', content.includes('Loading'));
});
