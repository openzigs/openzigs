# Cloudflare Tunnel — Multiplayer Presenter Mode

This document covers the networking requirements for running the Multiplayer Presenter Mode behind a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/).

## Architecture

```
┌──────────┐  wss://your-domain/socket.io  ┌──────────────────┐  localhost:3000  ┌──────────────┐
│  Browser  │ ─────────────────────────────► │ Cloudflare Tunnel│ ───────────────► │ OpenZigs     │
│  (Guest)  │  wss://your-domain/peerjs     │  (cloudflared)   │                  │ Express +    │
│           │ ─────────────────────────────► │                  │ ───────────────► │ Socket.IO +  │
└──────────┘                                └──────────────────┘                  │ PeerJS       │
                                                                                  └──────────────┘
```

All three services — the REST API, Socket.IO, and PeerJS signaling — share **the same port** (default 3000). Cloudflare Tunnel forwards all traffic to that single origin, so no additional path routing rules are needed.

## Cloudflare Tunnel Configuration

### `~/.cloudflared/config.yml` — No Changes Required

If your tunnel already proxies to `http://localhost:3000`, multiplayer works out of the box:

```yaml
tunnel: <your-tunnel-id>
credentials-file: /path/to/credentials.json

ingress:
  - hostname: your-domain.com
    service: http://localhost:3000
  - service: http_status:404
```

Cloudflare Tunnel transparently proxies all paths including `/peerjs/*` and `/socket.io/*` over HTTPS/WSS because they share the same origin port. No path-level rules are required.

## Key Configuration Notes

### `proxied: true` Is Required

The PeerJS server is configured with `proxied: true`:

```typescript
const peerServer = ExpressPeerServer(httpServer, {
  path: "/",
  proxied: true,          // ← required for Cloudflare
  alive_timeout: 60000,
  key: "openzigs",
});
app.use(peerServer);
```

**Why:** Without `proxied: true`, PeerJS uses the raw TCP socket's remote IP as the client identifier. Behind Cloudflare, all connections originate from Cloudflare's edge IPs, causing **peer ID collisions**. With `proxied: true`, PeerJS reads `X-Forwarded-For` headers instead.

### ICE Servers

The default PeerJS client config uses Google's public STUN servers:

```typescript
config: {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun1.l.google.com:19302' },
  ],
}
```

This works for most residential and mobile NATs. If guests are behind **symmetric NATs** (corporate VPN, enterprise firewalls, some mobile carriers), you may need to add a TURN server:

```typescript
{
  urls: 'turns:your-turn-server.com:443',
  username: 'user',
  credential: 'pass',
}
```

### WebSocket Endpoint

The PeerJS browser client connects to:

```
wss://<your-domain>/peerjs/openzigs?key=openzigs&id=<peer-id>&token=<token>
```

This is handled automatically by the PeerJS client constructor — no manual URL building is needed.

## Verifying the Tunnel Forwards PeerJS

```bash
# Should return HTTP 101 Switching Protocols (or upgrade error from curl)
curl -v \
  --header "Upgrade: websocket" \
  --header "Connection: Upgrade" \
  "https://<your-domain>/peerjs/openzigs?key=openzigs&id=test123&token=testtoken"
```

A successful response (or `101 Switching Protocols` before curl fails to complete the WS handshake) confirms the tunnel is forwarding PeerJS signaling traffic.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Invite URL says `localhost:3000` | `presenter.baseUrl` not set | Set `presenter.baseUrl` in `~/.openzigs/config.json` to your public domain |
| "Invite Link Invalid" | Secret mismatch after redeploy | Delete `presenter.inviteSecret` from config, restart server |
| Peers can't connect, all have same ID | `proxied: true` not set | Ensure PeerJS config has `proxied: true` |
| WebSocket upgrade fails through tunnel | Cloudflare WebSocket not enabled | Enable WebSocket in Cloudflare dashboard (Network → WebSockets) |
| Audio works locally but not remotely | ICE candidates blocked by NAT | Add a TURN server to `iceServers` config |
| PeerJS connection times out | `alive_timeout` too low | Increase `alive_timeout` (default: 60000ms) |
| Stale peers listed after disconnect | Room cleanup not triggering | Check Socket.IO `disconnect` handler calls `roomManager.leave()` |

## Invite Link Configuration

When running behind a Cloudflare Tunnel, set `presenter.baseUrl` in `~/.openzigs/config.json` so invite links use your public domain:

```json
{
  "presenter": {
    "baseUrl": "https://openzigs.example.com"
  }
}
```

Without this, invite URLs will contain `http://localhost:3000` which guests cannot access.

The invite secret (`presenter.inviteSecret`) is auto-generated and persisted to `~/.openzigs/config.json` on first startup. It survives restarts — no manual configuration required.

For the full tunnel setup walkthrough including DNS and Docker Compose, see [USER_GUIDE.md — Cloudflare Tunnel Setup for Invite Links](USER_GUIDE.md#cloudflare-tunnel-setup-for-invite-links).
