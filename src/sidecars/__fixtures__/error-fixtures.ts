/**
 * Shared fixtures for sidecar error envelopes.
 *
 * These cover the real shapes we have observed in production from the various
 * FastAPI / Python sidecars (v2a, lipsync, music, image-gen, image-processing,
 * worker, music-studio). They are consumed by `error-normalizer.test.ts` and
 * by per-proxy error-path tests so that the contract is exercised end-to-end.
 *
 * Each fixture intentionally documents the wire shape — do not "tidy" the
 * string-escaping or whitespace; that is the point.
 */

export type ErrorFixture = {
  name: string;
  status?: number;
  input: string;
  expectedUserMessage: string;
  expectedCode?: string;
};

export const errorFixtures: ReadonlyArray<ErrorFixture> = [
  {
    name: "plain-text-stack-trace",
    status: 500,
    input:
      'Traceback (most recent call last):\n  File "/app/server.py", line 42, in handle\n    raise RuntimeError("boom")\nRuntimeError: boom',
    expectedUserMessage: "boom",
  },
  {
    name: "plain-text-non-traceback",
    status: 500,
    input: "Internal Server Error",
    expectedUserMessage: "Internal Server Error",
  },
  {
    name: "empty-body-500",
    status: 500,
    input: "",
    expectedUserMessage: "Sidecar returned HTTP 500 with no body.",
  },
  {
    name: "empty-body-no-status",
    input: "",
    expectedUserMessage: "Sidecar returned an empty error response.",
  },
  {
    name: "json-error-string",
    input: '{"error":"Reference audio must be 3-10 seconds"}',
    expectedUserMessage: "Reference audio must be 3-10 seconds",
  },
  {
    name: "json-detail-string",
    input: '{"detail":"Voice id not found"}',
    expectedUserMessage: "Voice id not found",
  },
  {
    name: "json-message-string",
    input: '{"message":"Worker offline"}',
    expectedUserMessage: "Worker offline",
  },
  {
    name: "json-nested-error-message",
    input: '{"error":{"message":"Out of memory","code":"oom"}}',
    expectedUserMessage: "Out of memory",
    expectedCode: "oom",
  },
  {
    name: "json-double-escaped",
    input: '"{\\"error\\":\\"Model not loaded\\"}"',
    expectedUserMessage: "Model not loaded",
  },
  {
    name: "json-detail-with-embedded-json",
    input:
      '{"detail":"Request failed: {\\"exception\\":\\"FileNotFoundError: /tmp/ref.wav\\"}"}',
    expectedUserMessage:
      'Request failed: {"exception":"FileNotFoundError: /tmp/ref.wav"}',
  },
  {
    name: "fastapi-validation-error",
    input:
      '{"detail":[{"loc":["body","duration"],"msg":"ensure this value is less than or equal to 10","type":"value_error.number.not_le"}]}',
    expectedUserMessage:
      "body.duration: ensure this value is less than or equal to 10",
  },
  {
    name: "fastapi-validation-error-multiple",
    input:
      '{"detail":[{"loc":["body","duration"],"msg":"too long","type":"x"},{"loc":["body","voice"],"msg":"required","type":"y"}]}',
    expectedUserMessage: "body.duration: too long; body.voice: required",
  },
  {
    name: "envelope-with-code-and-hint",
    input:
      '{"error":{"code":"insufficient_unified_memory","message":"Need 24GB+","hint":"Route to remote lipsync node"}}',
    expectedUserMessage: "Need 24GB+",
    expectedCode: "insufficient_unified_memory",
  },
  {
    name: "timeout-message",
    status: 504,
    input: '{"error":"Upstream timed out after 30s"}',
    expectedUserMessage: "Upstream timed out after 30s",
  },
  {
    name: "html-error-page",
    status: 502,
    input: "<html><body><h1>502 Bad Gateway</h1></body></html>",
    expectedUserMessage: "Sidecar returned HTTP 502 (non-JSON response).",
  },
  {
    name: "json-with-Exception-key",
    input: '{"Exception":"ValueError: bad input"}',
    expectedUserMessage: "ValueError: bad input",
  },
  {
    name: "json-null-body",
    input: "null",
    expectedUserMessage: "Sidecar returned an empty error response.",
  },
];

/** Look up a fixture by name. Throws if missing — fixtures are constants. */
export function getErrorFixture(name: string): ErrorFixture {
  const fx = errorFixtures.find((f) => f.name === name);
  if (!fx) throw new Error(`Unknown error fixture: ${name}`);
  return fx;
}
