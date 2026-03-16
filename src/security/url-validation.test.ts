import { describe, it, expect } from "vitest";
import { isAllowedWebhookUrl } from "./url-validation.js";

describe("isAllowedWebhookUrl (SSRF protection)", () => {
  // ── Allowed URLs ──────────────────────────────────────────

  it("allows https://example.com", () => {
    expect(isAllowedWebhookUrl("https://example.com/hook")).toBe(true);
  });

  it("allows http://api.example.com", () => {
    expect(isAllowedWebhookUrl("http://api.example.com/callback")).toBe(true);
  });

  it("allows a real webhook URL", () => {
    expect(isAllowedWebhookUrl("https://hooks.slack.com/services/T00/B00/xxx")).toBe(true);
  });

  // ── Blocked: localhost ────────────────────────────────────

  it("blocks localhost", () => {
    expect(isAllowedWebhookUrl("http://localhost/admin")).toBe(false);
  });

  it("blocks localhost with port", () => {
    expect(isAllowedWebhookUrl("http://localhost:3000/api")).toBe(false);
  });

  it("blocks 127.0.0.1", () => {
    expect(isAllowedWebhookUrl("http://127.0.0.1/secret")).toBe(false);
  });

  it("blocks [::1] (IPv6 loopback)", () => {
    expect(isAllowedWebhookUrl("http://[::1]/admin")).toBe(false);
  });

  it("blocks 0.0.0.0", () => {
    expect(isAllowedWebhookUrl("http://0.0.0.0:8080/")).toBe(false);
  });

  // ── Blocked: cloud metadata ───────────────────────────────

  it("blocks AWS metadata (169.254.169.254)", () => {
    expect(isAllowedWebhookUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
  });

  it("blocks GCP metadata (metadata.google.internal)", () => {
    expect(isAllowedWebhookUrl("http://metadata.google.internal/computeMetadata/v1/")).toBe(false);
  });

  // ── Blocked: link-local ───────────────────────────────────

  it("blocks link-local 169.254.x.x", () => {
    expect(isAllowedWebhookUrl("http://169.254.1.1/")).toBe(false);
  });

  // ── Blocked: private IPv4 ranges ──────────────────────────

  it("blocks 10.x.x.x", () => {
    expect(isAllowedWebhookUrl("http://10.0.0.1/internal")).toBe(false);
  });

  it("blocks 192.168.x.x", () => {
    expect(isAllowedWebhookUrl("http://192.168.1.1/router")).toBe(false);
  });

  it("blocks 172.16.x.x", () => {
    expect(isAllowedWebhookUrl("http://172.16.0.1/")).toBe(false);
  });

  it("blocks 172.31.x.x", () => {
    expect(isAllowedWebhookUrl("http://172.31.255.255/")).toBe(false);
  });

  it("allows 172.32.x.x (not private)", () => {
    expect(isAllowedWebhookUrl("http://172.32.0.1/")).toBe(true);
  });

  // ── Blocked: IPv6 private ─────────────────────────────────

  it("blocks [fe80::] link-local IPv6", () => {
    expect(isAllowedWebhookUrl("http://[fe80::1]/")).toBe(false);
  });

  it("blocks [fc00::] unique local IPv6", () => {
    expect(isAllowedWebhookUrl("http://[fc00::1]/")).toBe(false);
  });

  it("blocks [fd00::] unique local IPv6", () => {
    expect(isAllowedWebhookUrl("http://[fd00::1]/")).toBe(false);
  });

  // ── Blocked: non-HTTP protocols ───────────────────────────

  it("blocks ftp://", () => {
    expect(isAllowedWebhookUrl("ftp://example.com/file")).toBe(false);
  });

  it("blocks file://", () => {
    expect(isAllowedWebhookUrl("file:///etc/passwd")).toBe(false);
  });

  it("blocks gopher://", () => {
    expect(isAllowedWebhookUrl("gopher://evil.com")).toBe(false);
  });

  // ── Blocked: invalid URLs ─────────────────────────────────

  it("blocks empty string", () => {
    expect(isAllowedWebhookUrl("")).toBe(false);
  });

  it("blocks garbage input", () => {
    expect(isAllowedWebhookUrl("not-a-url")).toBe(false);
  });
});
