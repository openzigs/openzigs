# Telegram Setup

This guide walks through everything needed to get Telegram working with OpenZigs, including Cloudflare Tunnel setup, bot creation, webhook configuration, and access control.

## Overview

OpenZigs uses a Telegram bot with **webhooks**. That means:

- Telegram sends updates to your server at a public HTTPS URL.
- OpenZigs does not start long polling.
- A tunnel (Cloudflare or similar) is required unless your server already has a public HTTPS URL.

## Step 1: Create a Telegram Bot

1. Open Telegram and start a chat with **@BotFather**.
2. Run `/newbot` and follow the prompts.
3. Copy the bot token (looks like `123456:ABCdef...`).
4. Optional but recommended:
   - Set a name and username.
   - Set a profile photo for clarity.

## Step 2: Collect Your Telegram User ID

You will need your user ID to restrict access later.

Options:

- Start a chat with **@userinfobot** and copy the `id` value.
- Use any Telegram user ID lookup bot you trust.

## Step 3: Configure Environment Variables

Add the token to your `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
```

Do not commit the token to git. Treat it like a password.

## Step 4: Enable Telegram in Config

You can use the Admin console (recommended) or edit config directly.

### Option A: Admin Console (preferred)

1. Open `http://localhost:3000/admin`.
2. In the **Channels** section, enable **Telegram**.
3. Set the webhook URL (see Step 5).
4. Save and restart the server when prompted.

### Option B: Config File

Create or edit `~/.openzigs/config.json`:

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "${TELEGRAM_BOT_TOKEN}",
      "webhookUrl": "https://example.trycloudflare.com/telegram/webhook",
      "allowedUsers": ["123456789"],
      "adminUserId": "123456789"
    }
  }
}
```

Notes:

- `allowedUsers` controls who can send messages to the bot.
- `adminUserId` controls who can run `/toggle` in Telegram.

## Step 5: Set Up Cloudflare Tunnel

OpenZigs supports Cloudflare Tunnel in two modes. **Quick mode** is easiest for local dev.

### Quick Mode (local dev)

1. Update `~/.openzigs/config.json`:

```json
{
  "tunnel": {
    "enabled": true,
    "mode": "quick"
  }
}
```

2. Start OpenZigs. It will print a public URL like:

```
https://abc123.trycloudflare.com
```

3. Set your webhook URL to:

```
https://abc123.trycloudflare.com/telegram/webhook
```

### Named Mode (production)

Use this if you want a stable domain.

1. Create a Cloudflare account and install `cloudflared`.
2. Create a tunnel and DNS route for your domain.
3. Store credentials at `~/.cloudflared/credentials.json`.
4. Update `~/.openzigs/config.json`:

```json
{
  "tunnel": {
    "enabled": true,
    "mode": "named",
    "namedTunnel": {
      "credentialsFile": "~/.cloudflared/credentials.json",
      "hostname": "agent.example.com"
    }
  }
}
```

5. Set your webhook URL to:

```
https://agent.example.com/telegram/webhook
```

## Step 6: Register the Webhook, Restart, and Validate

1. Restart the server after config changes.

2. Register the webhook with Telegram. Two options:

- Using the Admin console: enable Telegram and set the Webhook URL (and optional Webhook Secret) then click **Save & Restart**.

- Manually with curl (recommended if you want to set a secret explicitly):

```bash
curl -F "url=https://agent.openzigs.com/telegram/webhook" \
     -F "secret_token=MySecurePassword123" \
     https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook
```

If you provide a `secret_token`, Telegram will include an `X-Telegram-Bot-Api-Secret-Token` header on every webhook request. OpenZigs validates this header when provided.

3. Open Telegram and send `/start` to your bot.
4. Send a normal message and confirm you get a response.

If you do not receive a response:

- Verify the webhook URL is reachable and correct.
- Check server logs for webhook errors (webhook requests rejected with 403 indicate a secret mismatch).
- Make sure `TELEGRAM_BOT_TOKEN` is set.

## Access Control: Only You Can Message the Bot

OpenZigs supports allowlists for Telegram. To restrict access to only you:

```json
{
  "channels": {
    "telegram": {
      "allowedUsers": ["123456789"]
    }
  }
}
```

Behavior:

- If `allowedUsers` is **empty**, the bot is open to anyone who finds it.
- If `allowedUsers` has values, **only those Telegram user IDs** can send messages.
- Everyone else receives "Unauthorized".

Recommendation: Always set `allowedUsers` for Telegram, even in dev.

## Security Notes

- **Not open to massive traffic** by default. With an allowlist, only approved IDs can talk to the bot.
- **Webhook URL is public**, but access is controlled by Telegram (only Telegram sends signed requests) and by your allowlist.
- **Token hygiene**: rotate the Telegram token if it ever leaks.
- **Audit trail**: approvals and tool usage are logged in audit logs.
- **Scope**: keep tool permissions minimal. Disable tools you do not need.

## Troubleshooting

- **Webhook not firing**: confirm tunnel is running and URL is correct.
- **Unauthorized**: check that your user ID is in `allowedUsers` and matches exactly.
- **Bot responds in admin but not Telegram**: ensure the Telegram channel is enabled and webhook URL is set.

## References

- Telegram BotFather: https://t.me/BotFather
- Telegram user ID lookup: https://t.me/userinfobot
- Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
