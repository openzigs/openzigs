/**
 * Regression test for PR #1013 review feedback.
 *
 * Bug: in the original wire-up, `queueMaster.start()` was invoked BEFORE
 * `registerImageCompletionListener(...)` and the Socket.IO
 * `queueMaster.on("job:complete", ...)` broadcaster were attached. Any
 * `job:complete` event that fired in the wire-up window would be
 * dropped, causing the result PNG to never be copied into the pitch
 * assets dir.
 *
 * This test asserts the textual ordering of those calls in
 * `src/server.ts`: every listener attachment must occur strictly before
 * the call that arms the push loop.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_TS = resolve(__dirname, "server.ts");

describe("server.ts queueMaster wire-up ordering (PR #1013 regression)", () => {
  const source = readFileSync(SERVER_TS, "utf8");

  const startIdx = source.indexOf("queueMaster.start();");
  const listenerIdx = source.indexOf(
    "pitchImageCompletionRegistration = registerImageCompletionListener(",
  );
  const jobCompleteIdx = source.indexOf('queueMaster.on("job:complete"');

  it("registers the pitch image completion listener before queueMaster.start()", () => {
    expect(listenerIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(-1);
    expect(listenerIdx).toBeLessThan(startIdx);
  });

  it("attaches the Socket.IO job:complete broadcaster before queueMaster.start()", () => {
    expect(jobCompleteIdx).toBeGreaterThan(-1);
    expect(startIdx).toBeGreaterThan(-1);
    expect(jobCompleteIdx).toBeLessThan(startIdx);
  });

  it("only calls queueMaster.start() once in the boot sequence", () => {
    const matches = source.match(/queueMaster\.start\(\);/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
