# Remote Media Worker Nodes via Cloudflare Tunnel

This guide shows how to expose a remote machine running OpenZigs media sidecars
(image generation, video generation, music generation, RVC, lip sync) to your
primary OpenZigs server over the public internet using Cloudflare Tunnel —
without opening any inbound firewall ports.

## Table of Contents

1. [Overview & architecture](#1-overview--architecture)
2. [Prerequisites](#2-prerequisites)
3. [Install cloudflared on the worker](#3-install-cloudflared-on-the-worker)
4. [Authenticate and create a tunnel](#4-authenticate-and-create-a-tunnel)
5. [Ingress configuration](#5-ingress-configuration)
6. [DNS routing](#6-dns-routing)
7. [Run the tunnel under launchd / systemd](#7-run-the-tunnel-under-launchd--systemd)
8. [`CALLBACK_SECRET` and signed callbacks](#8-callback_secret-and-signed-callbacks)
9. [Admin UI walkthrough](#9-admin-ui-walkthrough)
10. [Cloudflare Access (optional, recommended)](#10-cloudflare-access-optional-recommended)
11. [Verify with the smoke test](#11-verify-with-the-smoke-test)
12. [Troubleshooting](#12-troubleshooting)
13. [Backwards compatibility](#13-backwards-compatibility)

---

## 1. Overview & architecture

```
┌────────────────────┐         ┌─────────────────────┐         ┌──────────────────────┐
│  OpenZigs server   │ HTTPS   │ Cloudflare Tunnel   │ HTTPS   │  Worker machine      │
│  (chat, queue,     │ ──────▶ │  (CF edge → worker) │ ──────▶ │  cloudflared + sidec.│
│   admin UI)        │         │                     │         │  (image-gen, etc.)   │
└────────────────────┘         └─────────────────────┘         └──────────────────────┘
        ▲                                                                  │
        │  HMAC-signed POST /api/queue/complete                            │
        └──────────────────────────────────────────────────────────────────┘
```

The OpenZigs server submits jobs to the worker; the worker posts results back
to the server's `/api/queue/complete` endpoint with HMAC signatures (see
[§8](#8-callback_secret-and-signed-callbacks)).

## 2. Prerequisites

- A Cloudflare account with a domain you control (free plan is fine).
- A worker machine reachable from the internet via `cloudflared` (Mac, Linux,
  or Windows).
- One or more sidecars already running locally on the worker — see
  [docs/INSTALL.md](INSTALL.md) for sidecar setup.
- The `OPENZIGS_PUBLIC_URL` of your primary server (the worker must be able to
  reach it for callbacks).

## 3. Install cloudflared on the worker

macOS:

```bash
brew install cloudflared
```

Linux (Debian/Ubuntu):

```bash
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cf.deb
sudo dpkg -i /tmp/cf.deb
```

Windows: download the MSI from Cloudflare's releases page.

## 4. Authenticate and create a tunnel

```bash
cloudflared tunnel login                       # opens browser; pick your zone
cloudflared tunnel create openzigs-worker
```

Note the tunnel UUID printed at the end. The credentials file lands at
`~/.cloudflared/<UUID>.json`.

## 5. Ingress configuration

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <UUID>
credentials-file: /Users/<you>/.cloudflared/<UUID>.json

ingress:
  - hostname: image.example.com
    service: http://127.0.0.1:5005
  - hostname: video.example.com
    service: http://127.0.0.1:5007
  - hostname: music.example.com
    service: http://127.0.0.1:5009
  - hostname: rvc.example.com
    service: http://127.0.0.1:5010
  - hostname: lip.example.com
    service: http://127.0.0.1:5010
  - service: http_status:404
```

Map each hostname to the local port of the corresponding sidecar.

## 6. DNS routing

Tell Cloudflare to route the hostnames into the tunnel:

```bash
cloudflared tunnel route dns openzigs-worker image.example.com
cloudflared tunnel route dns openzigs-worker video.example.com
# repeat for each hostname above
```

## 7. Run the tunnel under launchd / systemd

macOS (launchd):

```bash
sudo cloudflared service install
sudo launchctl start com.cloudflare.cloudflared
```

Linux (systemd):

```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

## 8. `CALLBACK_SECRET` and signed callbacks

OpenZigs sidecars call back to the primary server using HMAC-SHA256 signatures
over `"{timestamp}.{raw_body}"` with a ±300s freshness window. Both sides need
the same shared secret.

On the **primary server**, set in `~/.openzigs/config.json`:

```jsonc
{
  "auth": {
    "workerSecret": "GENERATE-A-LONG-RANDOM-STRING",
    "allowLegacyBearer": true,         // false to require HMAC
    "callbackRateLimit": { "perMinute": 60, "burst": 10 }
  }
}
```

On the **worker**, export the same value before launching each sidecar:

```bash
export CALLBACK_SECRET="GENERATE-A-LONG-RANDOM-STRING"
export OPENZIGS_CALLBACK_URL="https://your-primary-server/api/queue/complete"
```

`OPENZIGS_CALLBACK_URL` is also used by the sidecar SSRF guard as a
server-controlled trusted callback host. Local/LAN callback URLs continue to
work by default; public callback hosts are accepted only when their host exactly
matches `OPENZIGS_CALLBACK_URL` or an entry in `OPENZIGS_TRUSTED_CALLBACK_HOSTS`
(comma-separated host, host:port, or URL values). Do not put arbitrary domains
in that allowlist; it should contain only your OpenZigs primary callback hosts.

For launchd/systemd-managed sidecars, set the env var in the unit's
`EnvironmentFile`/`<key>EnvironmentVariables</key>` plist block. Example
launchd snippet:

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>CALLBACK_SECRET</key>
    <string>GENERATE-A-LONG-RANDOM-STRING</string>
    <key>OPENZIGS_CALLBACK_URL</key>
    <string>https://your-primary-server/api/queue/complete</string>
</dict>
```

Sidecars use `sidecars/_shared/signed_callback.py` to compute headers
automatically — no per-sidecar code changes are needed if you upgraded to the
shipped version.

## 9. Admin UI walkthrough

1. Navigate to `Admin → Remote Media Worker Nodes`.
2. For each node you want remote, paste the public URL (e.g.
   `https://image.example.com`).
3. Optionally paste a Bearer token for sidecar-level authorization. If the
  hostname is protected by Cloudflare Access, also fill the CF Access service
  token fields described in [§10](#10-cloudflare-access-optional-recommended).
4. Leave **Allow LAN** off unless the URL resolves to a private RFC1918
   address.
5. Click **Test Connection**. You should see two green ticks for `/health` and
   `/capabilities`.
6. Click **Save**. The URL is validated against SSRF rules
   (loopback/link-local/metadata-IP blocked) before it is persisted to
   `~/.openzigs/config.json`.

## 10. Cloudflare Access (optional, recommended)

Use Cloudflare Access when your tunnel hostnames are public but should only be
callable by your primary OpenZigs server. Access service tokens authenticate the
request at Cloudflare's edge before traffic reaches the worker; OpenZigs can
still send its normal Bearer token to the sidecar behind that edge gate.

Recommended production layering after this feature lands is option 3:
**Cloudflare Access in front + Bearer/HMAC inside**.

- Cloudflare Access service token: protects inbound dispatch requests at the
  Cloudflare edge with `CF-Access-Client-Id` and
  `CF-Access-Client-Secret`.
- Remote node Bearer token: optionally authenticates the dispatch inside the
  sidecar after the request passes Access.
- HMAC-signed callbacks: protect worker-to-primary callbacks on
  `/api/queue/complete` and `/api/queue/progress`.

To configure Access:

1. In the Cloudflare dashboard, open `Zero Trust → Access → Applications →
  Add an application → Self-hosted`.
2. Add each node hostname, such as `image.example.com`, `video.example.com`,
  and `music.example.com`.
3. Open `Zero Trust → Access → Service Auth → Service Tokens`, create a token,
  and copy both the `Client ID` and `Client Secret` values.
4. Return to the Access application and add an Access policy that allows that
  service token. Keep the policy scoped to the worker hostnames used by
  OpenZigs.
5. In OpenZigs, open `Admin → Remote Media Worker Nodes`, paste the node URL,
  and fill the per-node **CF-Access-Client-Id** and
  **CF-Access-Client-Secret** fields.
6. Click **Test Connection**. The probe sends both CF Access headers to
  `/health` and `/capabilities`, plus `Authorization: Bearer ...` if a node
  token is set.
7. Click **Save**. The Admin API persists the service token, masks the secret
  on future GET responses, and reports only `hasCfAccessClientSecret: true` to
  the UI. Use **Clear CF Access secret** to remove the stored Access secret
  without resetting the node URL.

If the CF Access fields are blank, OpenZigs sends no `CF-Access-Client-*`
headers. This keeps existing tunnel-only and Bearer-only deployments backwards
compatible.

## 11. Verify with the smoke test

Run the bundled smoke test from the primary server:

```bash
./scripts/test-remote-nodes.sh
```

It probes `/health` and `/capabilities` for every configured node, submits a
tiny job, and waits up to 60 seconds for the callback. Pass `--node image-gen`
to test a single node.

## 12. Troubleshooting

| Symptom                                        | Likely cause                                                                  | Fix                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `400 ssrf_blocked` when saving URL             | URL resolves to a private/loopback/metadata IP                                | Use a public hostname, or tick **Allow LAN** for RFC1918 ranges                    |
| `400 lan_not_allowed`                          | URL resolves to RFC1918 but **Allow LAN** is off                              | Tick the checkbox or use a public hostname                                         |
| Test shows `/health: OK`, `/capabilities: FAIL`| Sidecar is on an old build without `/capabilities`                            | Update the sidecar (run `pip install -r requirements.txt && restart`)              |
| Callbacks fail with `401`                      | `CALLBACK_SECRET` mismatch or clock skew >5min between primary and worker     | Check secrets on both sides and `ntpdate`/`chrony` clocks                          |
| Public callbacks rejected as SSRF              | Worker does not trust the primary callback host                                | Set `OPENZIGS_CALLBACK_URL=https://your-primary-server/api/queue/complete` or add the host to `OPENZIGS_TRUSTED_CALLBACK_HOSTS` |
| `429 rate_limited` from `/api/queue/complete`  | Worker is firing too many callbacks                                           | Raise `auth.callbackRateLimit.perMinute` in primary `config.json`                  |
| Test request succeeds but UI shows `WifiOff`   | `url` saved but cleared by an env var override                                | Check that `OPENZIGS_*_NODE_URL` env vars on the primary server are not overriding |
| Cloudflare returns `502`                       | Sidecar not running on the mapped local port                                  | `lsof -iTCP:<port>` on the worker; restart the sidecar                             |

## 13. Backwards compatibility

- `auth.allowLegacyBearer: true` (the default for one release) keeps the legacy
  `Authorization: Bearer <token>` callback path working. You'll see warning
  logs once per hour per node.
- Set `auth.allowLegacyBearer: false` once all sidecars are on the signed
  helper to enforce HMAC-only.
