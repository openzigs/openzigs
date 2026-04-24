# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| Latest  | :white_check_mark: |
| < 1.0   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability within OpenZigs, please send an email to **matt@openzigs.ai**. All security vulnerabilities will be promptly addressed.

Please include the following information in your report:

- **Type of vulnerability** (e.g., buffer overflow, SQL injection, cross-site scripting)
- **Full paths of source file(s)** related to the vulnerability
- **Location of the affected source code** (tag/branch/commit or direct URL)
- **Step-by-step instructions** to reproduce the issue
- **Proof-of-concept or exploit code** (if possible)
- **Impact of the issue**, including how an attacker might exploit it

## Response Timeline

- **Initial Response**: Within 48 hours of receiving your report
- **Status Update**: Within 7 days with our assessment
- **Resolution**: We aim to resolve critical issues within 30 days

## Disclosure Policy

- We will work with you to understand and resolve the issue quickly
- We will keep you informed of our progress
- We will credit you in any public disclosure (unless you prefer to remain anonymous)
- We ask that you give us reasonable time to address the issue before any public disclosure

## Security Best Practices for Users

When deploying OpenZigs:

### Authentication & Access

- Use strong, unique values for `OPENZIGS_TOKEN`
- Rotate authentication tokens periodically
- Restrict access to the admin API (`/api/admin`)
- Use HTTPS in production (via Cloudflare Tunnel or reverse proxy)

### Network Security

- Do not expose the server directly to the internet without a reverse proxy
- Use Cloudflare Tunnel for secure external access
- Configure appropriate firewall rules
- Bind to `localhost` when running locally

### API Keys & Secrets

- Store API keys in environment variables or `~/.openzigs/config.json`
- Never commit secrets to version control
- Use the Secret Vault feature for sensitive credentials
- Review `.gitignore` to ensure secrets are excluded

### File Permissions

- Auth tokens are stored with `0600` permissions
- Config files should have restricted read access
- Log files may contain sensitive information

### Docker Security

- Use official images from trusted registries
- Regularly update container images
- Don't run containers as root when possible
- Use Docker secrets for sensitive values

### Audit Logging

- Enable audit logging for security-relevant events
- Monitor logs for suspicious activity
- Retain logs for an appropriate period

## Security Features

OpenZigs includes several security features:

- **Approval Queue**: Human-in-the-loop approval for sensitive tool operations
- **Secret Vault**: Zero-trust credential storage with encryption
- **Audit Logger**: Comprehensive logging with value redaction
- **Access Control**: Per-channel and per-entity tool scoping
- **Rate Limiting**: Protection against abuse (configurable)

## Known Limitations

- Webhook configurations are currently in-memory (not persisted across restarts)
- Some MCP tools may execute arbitrary commands (configure tool restrictions appropriately)

## Contact

For security concerns, contact: **matt@openzigs.ai**

For general questions, use GitHub Issues or Discussions.

## CodeQL configuration

This repository uses a custom CodeQL configuration at .github/codeql/codeql-config.yml that scopes two queries away from the Python sidecars under sidecars/**:

- py/path-injection
- py/command-line-injection

These queries remain **fully enabled** for src/** (TypeScript backend) and ui/** (Next.js frontend), where the threat model is different — those layers are reachable from untrusted external HTTP/WebSocket clients.

### Why the sidecar carve-out is safe

1. **Localhost binding.** Every CUDA sidecar binds to 127.0.0.1 and is never exposed externally. The only legitimate caller is the in-process queue master inside the openzigs API server.
2. **Bearer token auth.** Every state-changing endpoint uses `Depends(verify_token)` against `OPENZIGS_TOKEN` (or the sidecar-specific shared secret).
3. **Pydantic validation at the FastAPI layer.** Every request body is a typed Pydantic model — type, length, and field-shape checks happen before any handler code runs.
4. **Runtime path containment.** Every path that crosses into `subprocess` or filesystem I/O is normalized with the following pattern, which IS a correct sanitizer that CodeQL cannot statically model:

   `python
   candidate = pathlib.Path(user_input).resolve()
   try:
       candidate.relative_to(trusted_root)   # raises ValueError on escape
   except ValueError:
       raise HTTPException(status_code=400, detail="path outside trusted root")
   `

5. **No `shell=True`.** Subprocess invocations are constructed from sanitized `Path` objects and constant flag strings, never interpolated into a shell.

### Rules for future sidecar code

- **MUST** keep the `Path.resolve() + .relative_to(trusted_root)` containment check on every user-influenced path before passing it to `subprocess` or filesystem APIs.
- **MUST** keep `shell=False` (the default) on all `subprocess` calls.
- **MUST** keep all sidecars bound to `127.0.0.1` and behind `verify_token`.
- **MUST NOT** echo raw exception text or stack traces to clients — log server-side and return a generic error code (see `py/stack-trace-exposure` finding fixed in PR #935).

If any of these defenses are removed, the CodeQL carve-out in `.github/codeql/codeql-config.yml` MUST be removed in the same change so the queries re-enable for `sidecars/**`.
