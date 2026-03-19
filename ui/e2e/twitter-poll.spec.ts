import { test, expect, navigateTo } from './helpers';

/**
 * E2E tests for Twitter polling integration in Social Brain.
 * Tests both the UI settings display and the backend API behaviour.
 */
test.describe('Social Brain — Twitter Polling', () => {
  const API_BASE = process.env.NEXT_PUBLIC_OPENZIGS_API_BASE || 'http://localhost:3000';
  const AUTH_TOKEN = process.env.NEXT_PUBLIC_OPENZIGS_TOKEN || '';
  const authHeaders = {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    'Content-Type': 'application/json',
  };

  test.describe('Settings UI', () => {
    test.beforeEach(async ({ page }) => {
      await navigateTo(page, '/social');
      await page.getByRole('button', { name: 'settings' }).click();
    });

    test('twitter platform card is visible in settings', async ({ page }) => {
      await expect(page.getByText('twitter').first()).toBeVisible();
    });

    test('twitter card shows polling mode indicator', async ({ page }) => {
      // The Twitter card should show "Polling" as its mode
      const twitterSection = page.locator('text=twitter').first().locator('..').locator('..');
      // Poll mode is shown as a toggle/badge — look for Polling text near the twitter card
      const pollingIndicator = twitterSection.getByText(/polling/i);
      await expect(pollingIndicator).toBeVisible();
    });

    test('twitter card shows Active status when configured', async ({ page }) => {
      // When TWITTER_BEARER_TOKEN is set, the card should show Active
      const twitterSection = page.locator('text=twitter').first().locator('..').locator('..');
      const activeIndicator = twitterSection.getByText(/active|connected|token set/i);
      await expect(activeIndicator.first()).toBeVisible();
    });

    test('youtube card shows polling mode', async ({ page }) => {
      const youtubeSection = page.locator('text=youtube').first().locator('..').locator('..');
      const pollingIndicator = youtubeSection.getByText(/polling/i);
      await expect(pollingIndicator).toBeVisible();
    });
  });

  test.describe('Connections API', () => {
    test('GET /api/social/connections returns twitter with polling mode', async ({ request }) => {
      const resp = await request.get(`${API_BASE}/api/social/connections`, {
        headers: authHeaders,
      });
      expect(resp.ok()).toBeTruthy();
      const body = await resp.json();
      const twitter = body.connections.find((c: { platform: string }) => c.platform === 'twitter');
      expect(twitter).toBeDefined();
      expect(twitter.mode).toBe('polling');
      expect(twitter.configured).toBe(true);
      expect(twitter.adapterRegistered).toBe(true);
    });

    test('GET /api/social/connections returns youtube with polling mode', async ({ request }) => {
      const resp = await request.get(`${API_BASE}/api/social/connections`, {
        headers: authHeaders,
      });
      expect(resp.ok()).toBeTruthy();
      const body = await resp.json();
      const youtube = body.connections.find((c: { platform: string }) => c.platform === 'youtube');
      expect(youtube).toBeDefined();
      expect(youtube.mode).toBe('polling');
      expect(youtube.activelyPolling).toBe(true);
    });

    test('GET /api/social/connections shows all enabled platforms as connected', async ({ request }) => {
      const resp = await request.get(`${API_BASE}/api/social/connections`, {
        headers: authHeaders,
      });
      expect(resp.ok()).toBeTruthy();
      const body = await resp.json();
      const enabledPlatforms = body.connections.filter((c: { enabled: boolean }) => c.enabled);
      for (const platform of enabledPlatforms) {
        expect(platform.adapterRegistered).toBe(true);
        expect(platform.configured).toBe(true);
      }
    });
  });

  test.describe('Webhook Log API', () => {
    test('GET /api/social/webhook-log returns event array', async ({ request }) => {
      const resp = await request.get(`${API_BASE}/api/social/webhook-log`, {
        headers: authHeaders,
      });
      expect(resp.ok()).toBeTruthy();
      const body = await resp.json();
      expect(Array.isArray(body.events)).toBe(true);
    });

    test('POST twitter webhook records event in webhook log', async ({ request }) => {
      // Send a simulated webhook payload
      const webhookResp = await request.post(
        `${API_BASE}/api/social/webhooks/twitter`,
        {
          headers: { 'Content-Type': 'application/json' },
          data: {
            tweet_create_events: [
              {
                id_str: `e2e_${Date.now()}`,
                text: '@testbot E2E test reply',
                user: { id_str: 'e2e_user_1', screen_name: 'e2e_tester', name: 'E2E Tester' },
                in_reply_to_status_id_str: 'original_tweet_123',
                created_at: new Date().toUTCString(),
              },
            ],
            for_user_id: 'test_account',
          },
        },
      );
      expect(webhookResp.ok()).toBeTruthy();
      const webhookBody = await webhookResp.json();
      expect(webhookBody.received).toBe(true);

      // Check webhook log — the event should appear
      const logResp = await request.get(`${API_BASE}/api/social/webhook-log`, {
        headers: authHeaders,
      });
      expect(logResp.ok()).toBeTruthy();
      const logBody = await logResp.json();
      const twitterEvents = logBody.events.filter(
        (e: { platform: string }) => e.platform === 'twitter',
      );
      expect(twitterEvents.length).toBeGreaterThan(0);
    });
  });

  test.describe('Twitter CRC Challenge', () => {
    test('GET /api/social/webhooks/twitter with crc_token returns HMAC', async ({ request }) => {
      const resp = await request.get(
        `${API_BASE}/api/social/webhooks/twitter?crc_token=e2e_test_challenge`,
      );
      expect(resp.ok()).toBeTruthy();
      const body = await resp.json();
      expect(body.response_token).toBeDefined();
      expect(body.response_token).toMatch(/^sha256=/);
    });
  });

  test.describe('Poll Health', () => {
    test('twitter poll health is tracked when polling is active', async ({ request }) => {
      const resp = await request.get(`${API_BASE}/api/social/connections`, {
        headers: authHeaders,
      });
      expect(resp.ok()).toBeTruthy();
      const body = await resp.json();
      const twitter = body.connections.find((c: { platform: string }) => c.platform === 'twitter');
      expect(twitter).toBeDefined();

      if (twitter.activelyPolling) {
        expect(twitter.pollHealth).toBeDefined();
        expect(typeof twitter.pollHealth.totalPolls).toBe('number');
        expect(twitter.pollHealth.totalPolls).toBeGreaterThanOrEqual(0);
      }
    });

    test('youtube poll health shows successful polls', async ({ request }) => {
      const resp = await request.get(`${API_BASE}/api/social/connections`, {
        headers: authHeaders,
      });
      expect(resp.ok()).toBeTruthy();
      const body = await resp.json();
      const youtube = body.connections.find((c: { platform: string }) => c.platform === 'youtube');
      expect(youtube).toBeDefined();
      expect(youtube.pollHealth).toBeDefined();
      expect(youtube.pollHealth.totalPolls).toBeGreaterThan(0);
      expect(youtube.pollHealth.consecutiveErrors).toBe(0);
    });
  });

  test.describe('Dashboard Platform Status', () => {
    test.beforeEach(async ({ page }) => {
      await navigateTo(page, '/social');
    });

    test('dashboard shows Connected Platforms section', async ({ page }) => {
      await expect(page.getByText('Connected Platforms')).toBeVisible();
    });

    test('dashboard reflects twitter connection status', async ({ page }) => {
      // The Connected Platforms section should show twitter as one of the connected platforms
      const platformSection = page.locator('text=Connected Platforms').locator('..');
      await expect(platformSection).toBeVisible();
    });
  });
});
